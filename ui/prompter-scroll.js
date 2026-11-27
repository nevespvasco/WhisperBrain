// Scrolling for the teleprompter. Pure numbers, so it is unit-tested; ui/prompter.js applies them to the page.

// Pixels per second for a reading speed: words per minute, measured words per line, line height in px.
export function pxPerSecond({ wpm, wordsPerLine, lineHeight }) {
  if (!(wpm > 0 && wordsPerLine > 0 && lineHeight > 0)) return 0;
  return (wpm / 60 / wordsPerLine) * lineHeight;
}

// Where to scroll so a line at `top` (px from the content's start) sits a third of the way down the view.
export function readingScroll({ top, viewHeight, contentHeight }) {
  const max = Math.max(0, contentHeight - viewHeight);
  return Math.max(0, Math.min(max, Math.round(top - viewHeight / 3)));
}

// The steady scroll: whole pixels per frame, carrying the fractions so slow speeds still move evenly.
export class Pacer {
  constructor() { this.paused = false; this.carry = 0; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  toggle() { this.paused = !this.paused; return this.paused; }
  tick(dtMs, pxPerSec) {
    if (this.paused || !(dtMs > 0) || !(pxPerSec > 0)) return 0;
    this.carry += (pxPerSec * Math.min(dtMs, 250)) / 1000; // a long gap (a hidden window) is not a jump
    const whole = Math.floor(this.carry);
    this.carry -= whole;
    return whole;
  }
}
