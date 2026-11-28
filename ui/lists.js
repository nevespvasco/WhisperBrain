// Long lists never stretch a page. Watches the page and looks after every list that grows past a size, without each view having to
// remember to:
//  - on the page itself (cards, rows): the first PAGE are shown and a "Show more" button adds the next PAGE (pagination in place);
//  - inside a panel, a side column or a dialog's body, where a tall list pushes everything else away: a fixed height with its own
//    scroll (see .scroll-list in styles.css).
// A view that wants no help puts data-nocap on the list. Lists that already scroll (the transcript, the chat, the sidebar) are left alone.
import { t } from './i18n.js';

export const PAGE = 24;          // rows shown at first and added by each "Show more"
export const SCROLL_AFTER = 8;   // a list in a panel scrolls once it has more rows than this

const LISTS = '.list, .cards, .gl-grid, .as-list, [data-cap]';   // data-cap: any other list a view wants looked after (a .stack of rows)
const SKIP = '[data-nocap], .segs, .chat, .side-list, .pal-results, .menu, .picklist, .picker, .seg-ctl, .tabs, .chips';
const state = new WeakMap();    // list -> { shown }

const size = (el) => Number(el.dataset.page) || PAGE;   // data-page: a list that wants a shorter first page
const rows = (el) => [...el.children].filter((c) => !c.classList.contains('cap-more'));

// does something between this list and its page already limit its height?
function scrolls(el) {
  const o = getComputedStyle(el).overflowY;
  return o === 'auto' || o === 'scroll';
}

function more(el) {
  let box = el.nextElementSibling;
  if (box?.classList.contains('cap-more')) return box;
  box = document.createElement('div');
  box.className = 'cap-more';
  box.innerHTML = '<button type="button" class="btn ghost sm"></button>';
  box.firstChild.addEventListener('click', () => {
    const st = state.get(el);
    if (!st) return;
    const before = rows(el)[st.shown];   // the first row that was hidden: focus goes there, so keyboard users keep their place
    st.shown += size(el);
    apply(el);
    before?.querySelector?.('a, button, input, [tabindex]')?.focus?.({ preventScroll: false });
  });
  el.after(box);
  return box;
}

function release(el) {
  const st = state.get(el);
  if (!st) return;
  for (const c of el.children) c.classList.remove('cap-hidden');
  if (el.nextElementSibling?.classList.contains('cap-more')) el.nextElementSibling.remove();
  el.classList.remove('scroll-list');
  state.delete(el);
}

function apply(el) {
  const list = rows(el), st = state.get(el);
  list.forEach((c, i) => c.classList.toggle('cap-hidden', i >= st.shown));
  const left = list.length - st.shown;
  const box = more(el);
  box.hidden = left <= 0;
  if (left > 0) {
    const n = Math.min(size(el), left);
    box.firstChild.textContent = t('Show {n} more', { n });
    box.firstChild.title = t('{shown} of {total} shown', { shown: st.shown, total: list.length });
    box.firstChild.setAttribute('aria-label', `${t('Show {n} more', { n })} (${t('{shown} of {total} shown', { shown: st.shown, total: list.length })})`);
  }
}

function sweep(root) {
  for (const el of root.querySelectorAll(LISTS)) {
    if (el.closest(SKIP) || el.matches(SKIP)) { release(el); continue; }
    const n = rows(el).length;
    const compact = !!el.closest('.panel, aside, dialog, .tabbody, .note-aside, .int-card');
    if (compact) {
      // a panel's list: a fixed height with its own scroll, once it has more rows than fit comfortably
      const on = n > SCROLL_AFTER && (el.classList.contains('scroll-list') || !scrolls(el));   // our own class makes it scroll: that is not "already scrolls" (it would flip off and on at every pass)
      el.classList.toggle('scroll-list', on);
      if (state.has(el)) release(el);
      continue;
    }
    if (n <= size(el)) { release(el); continue; }
    if (!state.has(el)) state.set(el, { shown: size(el) });
    apply(el);
  }
}

// root: the element a page is drawn into (#main). Safe to call once; it keeps watching for the life of the page.
export function watchLists(root) {
  let queued = false;
  const run = () => { queued = false; sweep(root); };
  new MutationObserver((muts) => {
    if (queued) return;
    // only changes to what a view drew count; the "Show more" buttons this file adds are not a reason to look again
    if (muts.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && n.classList.contains('cap-more')))) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(root, { childList: true, subtree: true });
}
