/* X11 helper (global key listener and paste).
 *   whisperbrain-x11 listen        imprime "D|U <keycode> <repeat>" por cada tecla premida/solta (XInput2 raw, global)
 *   whisperbrain-x11 paste [term]  envia Ctrl+V (ou Ctrl+Shift+V com "term") via XTest
 * Compilar: gcc -O2 -o whisperbrain-x11 whisperbrain-x11.c -lX11 -lXi -lXtst */
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XInput2.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int listen_mode(Display *d) {
  int op, ev, err;
  if (!XQueryExtension(d, "XInputExtension", &op, &ev, &err)) { fprintf(stderr, "sem XInput\n"); return 2; }
  int major = 2, minor = 0;
  if (XIQueryVersion(d, &major, &minor) != Success) { fprintf(stderr, "XInput2 indisponivel\n"); return 2; }
  unsigned char mask[XIMaskLen(XI_LASTEVENT)];
  memset(mask, 0, sizeof mask);
  XISetMask(mask, XI_RawKeyPress);
  XISetMask(mask, XI_RawKeyRelease);
  XIEventMask m = { XIAllMasterDevices, sizeof mask, mask };
  XISelectEvents(d, DefaultRootWindow(d), &m, 1);
  XFlush(d);
  setvbuf(stdout, NULL, _IOLBF, 0);
  for (;;) {
    XEvent e;
    XNextEvent(d, &e);
    if (e.xcookie.type != GenericEvent || e.xcookie.extension != op || !XGetEventData(d, &e.xcookie)) continue;
    if (e.xcookie.evtype == XI_RawKeyPress || e.xcookie.evtype == XI_RawKeyRelease) {
      XIRawEvent *r = (XIRawEvent *)e.xcookie.data;
      printf("%c %d %d\n", e.xcookie.evtype == XI_RawKeyPress ? 'D' : 'U', r->detail, (r->flags & XIKeyRepeat) ? 1 : 0);
      fflush(stdout);
    }
    XFreeEventData(d, &e.xcookie);
  }
}

static void key(Display *d, KeySym s, Bool down) {
  XTestFakeKeyEvent(d, XKeysymToKeycode(d, s), down, 0);
  XFlush(d);
  usleep(8000);
}

static int paste_mode(Display *d, int term) {
  int a, b, c, dd;
  if (!XTestQueryExtension(d, &a, &b, &c, &dd)) { fprintf(stderr, "sem XTest\n"); return 2; }
  key(d, XK_Control_L, True);
  if (term) key(d, XK_Shift_L, True);
  key(d, XK_v, True);
  key(d, XK_v, False);
  if (term) key(d, XK_Shift_L, False);
  key(d, XK_Control_L, False);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "uso: %s listen|paste [term]\n", argv[0]); return 1; }
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "sem DISPLAY X11\n"); return 3; }
  int rc = !strcmp(argv[1], "listen") ? listen_mode(d)
         : !strcmp(argv[1], "paste")  ? paste_mode(d, argc > 2 && !strcmp(argv[2], "term"))
         : 1;
  XCloseDisplay(d);
  return rc;
}
