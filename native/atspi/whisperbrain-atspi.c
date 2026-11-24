/* Accessibility helper for Linux (AT-SPI): reads the page of a browser window and prints it as JSON lines.
 *   whisperbrain-atspi [--interval-ms N] [--apps REGEX] [--title REGEX] [--max-nodes N] [--visible-only] [--once] [--dump] [--list]
 *
 * One line per event, always:
 *   {"event":"hello","helper":"atspi","version":1}
 *   {"event":"status","state":"ok"|"no-apps"|"no-window"|"no-web-tree","app":"...","window":"..."}   (only when it changes)
 *   {"event":"snapshot","platform":"linux","app":"Brave Browser","window":"...","ms":12,"truncated":false,"nodes":[{"p":-1,"r":"document web","n":"...","a":{"id":"..."},"s":["showing"]},...]}
 * "p" is the index of the parent node in the same list (-1: the root of the page), so a reader rebuilds the tree in one pass.
 * The page's tree is only there when the browser was started with accessibility on (Chromium: --force-renderer-accessibility);
 * a matching window without it is reported as "no-web-tree".
 * The program decides nothing about meetings: which nodes mean what is the reader's business (src/meet/a11y.js).
 * Build: gcc -O2 -Wall -o whisperbrain-atspi whisperbrain-atspi.c $(pkg-config --cflags --libs atspi-2 gobject-2.0)  */
#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <regex.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop = 0;
static void on_signal(int s) { (void)s; stop = 1; }

static long now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000L + t.tv_nsec / 1000000L; }

static void json_str(GString *g, const char *s) {
  g_string_append_c(g, '"');
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    switch (*p) {
      case '"': g_string_append(g, "\\\""); break;
      case '\\': g_string_append(g, "\\\\"); break;
      case '\n': g_string_append(g, "\\n"); break;
      case '\r': g_string_append(g, "\\r"); break;
      case '\t': g_string_append(g, "\\t"); break;
      default:
        if (*p < 0x20) g_string_append_printf(g, "\\u%04x", *p);
        else g_string_append_c(g, (char)*p);
    }
  }
  g_string_append_c(g, '"');
}

static void emit(GString *g) { g_string_append_c(g, '\n'); fwrite(g->str, 1, g->len, stdout); fflush(stdout); }

typedef struct { GString *out; int count; int max; gboolean visible_only; gboolean truncated; } Walk;

static void attr_cb(gpointer key, gpointer value, gpointer data) {
  GString *g = data;
  if (g->str[g->len - 1] != '{') g_string_append_c(g, ',');
  json_str(g, key); g_string_append_c(g, ':'); json_str(g, value);
}

/* depth-first; the index of a node is its position in the output */
static void walk(AtspiAccessible *node, int parent, int depth, Walk *w) {
  if (w->count >= w->max) { w->truncated = TRUE; return; }
  if (depth > 120) return;
  GError *err = NULL;
  AtspiStateSet *states = atspi_accessible_get_state_set(node);
  gboolean showing = states && atspi_state_set_contains(states, ATSPI_STATE_SHOWING);
  if (w->visible_only && !showing && depth > 0) { if (states) g_object_unref(states); return; }
  int me = w->count++;
  gchar *name = atspi_accessible_get_name(node, &err); g_clear_error(&err);
  AtspiRole role = atspi_accessible_get_role(node, &err); g_clear_error(&err);
  gchar *rname = atspi_role_get_name(role);
  GHashTable *attrs = atspi_accessible_get_attributes(node, &err); g_clear_error(&err);
  GString *g = w->out;
  g_string_append_printf(g, "%s{\"p\":%d,\"r\":", me ? "," : "", parent);
  json_str(g, rname);
  g_string_append(g, ",\"n\":"); json_str(g, name);
  if (attrs && g_hash_table_size(attrs)) { g_string_append(g, ",\"a\":{"); g_hash_table_foreach(attrs, attr_cb, g); g_string_append_c(g, '}'); }
  if (states) {
    g_string_append(g, ",\"s\":[");
    gboolean first = TRUE;
    struct { AtspiStateType t; const char *n; } want[] = { { ATSPI_STATE_SHOWING, "showing" }, { ATSPI_STATE_FOCUSED, "focused" }, { ATSPI_STATE_CHECKED, "checked" }, { ATSPI_STATE_SELECTED, "selected" }, { ATSPI_STATE_PRESSED, "pressed" } };
    for (size_t i = 0; i < sizeof want / sizeof want[0]; i++) if (atspi_state_set_contains(states, want[i].t)) { g_string_append_printf(g, "%s\"%s\"", first ? "" : ",", want[i].n); first = FALSE; }
    g_string_append_c(g, ']');
  }
  g_string_append_c(g, '}');
  if (attrs) g_hash_table_unref(attrs);
  g_free(name); g_free(rname);
  if (states) g_object_unref(states);
  gint n = atspi_accessible_get_child_count(node, &err); g_clear_error(&err);
  for (gint i = 0; i < n && !w->truncated; i++) {
    AtspiAccessible *c = atspi_accessible_get_child_at_index(node, i, &err); g_clear_error(&err);
    if (!c) continue;
    walk(c, me, depth + 1, w);
    g_object_unref(c);
  }
}

/* the web content of a window: the first "document web" node, found breadth-first and not too deep */
static AtspiAccessible *find_document(AtspiAccessible *root) {
  GQueue *q = g_queue_new(); GQueue *depths = g_queue_new();
  g_object_ref(root); g_queue_push_tail(q, root); g_queue_push_tail(depths, GINT_TO_POINTER(0));
  AtspiAccessible *found = NULL; int visited = 0;
  while (!g_queue_is_empty(q)) {
    AtspiAccessible *n = g_queue_pop_head(q); int d = GPOINTER_TO_INT(g_queue_pop_head(depths));
    GError *err = NULL;
    if (!found && atspi_accessible_get_role(n, &err) == ATSPI_ROLE_DOCUMENT_WEB) { found = n; g_clear_error(&err); continue; }
    g_clear_error(&err);
    if (!found && d < 14 && visited++ < 400) {
      gint c = atspi_accessible_get_child_count(n, &err); g_clear_error(&err);
      for (gint i = 0; i < c; i++) { AtspiAccessible *k = atspi_accessible_get_child_at_index(n, i, &err); g_clear_error(&err); if (k) { g_queue_push_tail(q, k); g_queue_push_tail(depths, GINT_TO_POINTER(d + 1)); } }
    }
    g_object_unref(n);
  }
  while (!g_queue_is_empty(q)) g_object_unref(g_queue_pop_head(q));
  g_queue_free(q); g_queue_free(depths);
  return found;
}

static char *last_status = NULL;
static void status(const char *state, const char *app, const char *window) {
  GString *g = g_string_new(NULL);
  g_string_append_printf(g, "{\"event\":\"status\",\"state\":\"%s\",\"app\":", state); json_str(g, app);
  g_string_append(g, ",\"window\":"); json_str(g, window);
  g_string_append_c(g, '}');
  gchar *key = g_strdup_printf("%s|%s|%s", state, app ? app : "", window ? window : "");
  if (!last_status || strcmp(last_status, key)) { emit(g); g_free(last_status); last_status = key; } else g_free(key);
  g_string_free(g, TRUE);
}

int main(int argc, char **argv) {
  int interval = 500, max_nodes = 8000; const char *apps = "chrom|brave|edge|vivaldi|opera|firefox", *title = "meet|[a-z]{3}-[a-z]{4}-[a-z]{3}";
  gboolean once = FALSE, dump = FALSE, list = FALSE, visible_only = FALSE;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--interval-ms") && i + 1 < argc) interval = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--apps") && i + 1 < argc) apps = argv[++i];
    else if (!strcmp(argv[i], "--title") && i + 1 < argc) title = argv[++i];
    else if (!strcmp(argv[i], "--max-nodes") && i + 1 < argc) max_nodes = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--visible-only")) visible_only = TRUE;
    else if (!strcmp(argv[i], "--once")) once = TRUE;
    else if (!strcmp(argv[i], "--dump")) { dump = TRUE; once = TRUE; }
    else if (!strcmp(argv[i], "--list")) { list = TRUE; once = TRUE; }
    else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
  }
  if (interval < 100) interval = 100;
  regex_t re_app, re_title;
  if (regcomp(&re_app, apps, REG_EXTENDED | REG_ICASE | REG_NOSUB) || regcomp(&re_title, title, REG_EXTENDED | REG_ICASE | REG_NOSUB)) { fprintf(stderr, "bad regular expression\n"); return 2; }
  signal(SIGTERM, on_signal); signal(SIGINT, on_signal); signal(SIGPIPE, SIG_IGN);
  if (atspi_init() > 1) { printf("{\"event\":\"status\",\"state\":\"no-bus\",\"app\":\"\",\"window\":\"\"}\n"); fflush(stdout); return 3; }
  printf("{\"event\":\"hello\",\"helper\":\"atspi\",\"version\":1}\n"); fflush(stdout);

  long wait = interval;
  while (!stop) {
    long t0 = now_ms();
    GError *err = NULL;
    AtspiAccessible *desktop = atspi_get_desktop(0);
    gint napps = desktop ? atspi_accessible_get_child_count(desktop, &err) : 0; g_clear_error(&err);
    gboolean saw_window = FALSE, sent = FALSE;
    if (napps <= 0) status("no-apps", "", "");
    for (gint i = 0; i < napps && !stop; i++) {
      AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &err); g_clear_error(&err);
      if (!app) continue;
      gchar *an = atspi_accessible_get_name(app, &err); g_clear_error(&err);
      if (list) { printf("app: %s\n", an ? an : ""); }
      if (an && !regexec(&re_app, an, 0, NULL, 0)) {
        gint nw = atspi_accessible_get_child_count(app, &err); g_clear_error(&err);
        for (gint k = 0; k < nw && !stop; k++) {
          AtspiAccessible *win = atspi_accessible_get_child_at_index(app, k, &err); g_clear_error(&err);
          if (!win) continue;
          gchar *wn = atspi_accessible_get_name(win, &err); g_clear_error(&err);
          if (wn && !regexec(&re_title, wn, 0, NULL, 0)) {
            saw_window = TRUE;
            AtspiAccessible *doc = find_document(win);
            if (!doc) status("no-web-tree", an, wn);
            else {
              long w0 = now_ms();
              Walk w = { g_string_new(NULL), 0, dump ? 1000000 : max_nodes, visible_only && !dump, FALSE };
              walk(doc, -1, 0, &w);
              GString *g = g_string_new("{\"event\":\"snapshot\",\"platform\":\"linux\",\"app\":");
              json_str(g, an); g_string_append(g, ",\"window\":"); json_str(g, wn);
              g_string_append_printf(g, ",\"ms\":%ld,\"truncated\":%s,\"nodes\":[", now_ms() - w0, w.truncated ? "true" : "false");
              g_string_append_len(g, w.out->str, w.out->len); g_string_append(g, "]}");
              status("ok", an, wn); emit(g); sent = TRUE;
              g_string_free(g, TRUE); g_string_free(w.out, TRUE); g_object_unref(doc);
            }
          }
          g_free(wn); g_object_unref(win);
        }
      }
      g_free(an); g_object_unref(app);
    }
    if (napps > 0 && !saw_window) status("no-window", "", "");
    if (desktop) g_object_unref(desktop);
    (void)sent;
    if (once) break;
    /* a slow page is polled less often: never spend more than a third of the time walking it */
    long took = now_ms() - t0; wait = took * 3 > interval ? took * 3 : interval;
    for (long slept = 0; slept < wait && !stop; slept += 50) usleep(50 * 1000);
  }
  return 0;
}
