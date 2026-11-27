// The two chips a task is added with, wherever tasks are added (a meeting's action items, Promises): who owns it and when
// it is due. Due dates start today: a task is never due in the past.
import { t, esc, icon, avatar, fmtDate } from './lib.js';

export const todayIso = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

export function dueText(due) {
  const today = todayIso(), tomorrow = new Date(Date.parse(today) + 864e5).toISOString().slice(0, 10);
  if (due === today) return t('Today');
  if (due === tomorrow) return t('Tomorrow');
  const d = new Date(`${due}T12:00:00`);
  return fmtDate(d.getTime(), { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

// One calendar: the chip is the button, the date field inside it is only there to open the system date picker
export const dueChip = (id, due) => `<span class="chip act-due${due ? ' on' : ''}" title="${t('Due date')}">${icon('calendar', 'sm')}<span class="dl">${due ? esc(dueText(due)) : t('Due date')}</span><input type="date" id="${id}" min="${todayIso()}" value="${esc(due || '')}" aria-label="${t('Due date')}" tabindex="-1">${due ? `<button type="button" class="x" data-act="due-clear" aria-label="${t('No due date')}">${icon('x', 'sm')}</button>` : ''}</span>`;

export const ownerChip = (act, owner) => `<button type="button" class="chip${owner ? ' on' : ''}" data-act="${act}" aria-haspopup="listbox">${owner ? avatar(owner, { cls: 'xs' }) : icon('user', 'sm')}<span class="ellipsis">${owner ? esc(owner) : t('Unassigned')}</span>${icon('chevdown', 'sm')}</button>`;

// A click on a due chip: open the date picker, or clear the date (the input's change event redraws the chip)
export function dueClick(e, due) {
  e.preventDefault();
  const input = due.querySelector('input');
  if (e.target.closest('[data-act="due-clear"]')) { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); return; }
  input.min = todayIso();
  try { input.showPicker(); } catch { input.focus(); }
}

// The chip shows the date in words; the hidden field holds it
export function setDue(input) {
  input.closest('.act-due').outerHTML = dueChip(input.id, input.value && input.value >= todayIso() ? input.value : '');
}
