// A scrolling list of messages (transcript lines, chat answers) that follows the newest one. Scrolling up to re-read stops the
// following and shows a floating arrow; pressing it, or scrolling back to the bottom, follows again. Only the list scrolls, never
// the page around it. No imports, so the floating recorder (ui/widget.js) can use it too.
const NEAR = 60;

export function follow(box, jump, { onChange } = {}) {
  let on = true;
  const nearEnd = () => box.scrollHeight - box.scrollTop - box.clientHeight < NEAR;
  const overflows = () => box.scrollHeight - box.clientHeight > NEAR;
  const show = () => { if (jump) jump.hidden = on || !overflows(); };
  const set = (v) => { if (v !== on) { on = v; onChange?.(on); } show(); };
  // programmatic scrolls fire 'scroll' too: ignore the ones we cause, so they never switch the following off
  let ours = false;
  const toEnd = () => { ours = true; box.scrollTop = box.scrollHeight; requestAnimationFrame(() => { ours = false; }); };
  box.addEventListener('scroll', () => { if (!ours) set(nearEnd()); else show(); }, { passive: true });
  // a wheel / touch / key scroll upwards is the reader taking over, even before the position moves past the threshold
  box.addEventListener('wheel', (e) => { if (e.deltaY < 0) set(false); }, { passive: true });
  box.addEventListener('touchmove', () => { ours = false; }, { passive: true });
  box.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) set(false); });
  jump?.addEventListener('click', () => { set(true); toEnd(); });
  return {
    get following() { return on; },
    // after new content: keep the newest line in view while following, else just refresh the arrow
    update() { if (on) toEnd(); show(); },
    // jump to the newest line and follow again
    end() { set(true); toEnd(); },
    // set the following state without moving (a list drawn again where the reader had left it)
    set(v) { set(!!v); },
  };
}
