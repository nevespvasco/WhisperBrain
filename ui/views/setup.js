// "Is this computer ready?": what WhisperBrain needs from the operating system (PipeWire on Linux, permissions on macOS and
// Windows, ffmpeg…), with the command or the setting that fixes each one. Shown once on the first launch, and any time from
// Settings → Setup check. The list comes from GET /api/setup (src/platform/setup.js), so each system only sees its own.
import { S, api, t, esc, icon, modal, done, fail } from '../lib.js';

const LEVEL = { required: 'Needed to record', recommended: 'Recommended', optional: 'Optional' };
const STATE = { ok: ['ok', 'Ready'], missing: ['warn', 'Missing'], unknown: ['', 'Asked on first use'] };

function itemHtml(i) {
  const [cls, label] = STATE[i.status] || STATE.unknown;
  const bad = i.status !== 'ok';
  const cmds = (i.fix?.commands || []).map(([name, cmd]) => `<div class="su-cmd"><span class="xsmall muted">${esc(name)}</span><code>${esc(cmd)}</code><button class="btn ghost icon xs" data-copy="${esc(cmd)}" title="${t('Copy')}" aria-label="${t('Copy')}">${icon('copy', 'sm')}</button></div>`).join('');
  return `<div class="su-item ${i.status}">
    <span class="su-ic">${icon(i.status === 'ok' ? 'check' : 'alert', 'sm')}</span>
    <div class="grow">
      <div class="row"><b>${esc(t(i.title))}</b><span class="badge ${cls}">${t(label)}</span></div>
      <div class="small muted">${esc(t(i.why))}</div>
      ${bad && i.fix?.text ? `<div class="small su-fix">${esc(t(i.fix.text))}</div>` : ''}
      ${bad && i.fix?.settings ? `<a class="btn sm mt-s" href="#/settings/${i.fix.settings}" data-close-setup>${t('Open settings')}</a>` : ''}
      ${bad ? cmds : ''}
    </div>
  </div>`;
}

const bodyHtml = (r) => {
  const groups = ['required', 'recommended', 'optional'].map((lv) => [lv, r.items.filter((i) => i.level === lv)]).filter(([, l]) => l.length);
  return `<p class="muted" style="margin-top:0">${r.ready ? t('Everything needed to record is in place.') : t('Some things are missing before recording will work.')} ${t('Nothing here leaves your computer.')}</p>
    ${groups.map(([lv, list]) => `<h4 class="su-h">${t(LEVEL[lv])}</h4>${list.map(itemHtml).join('')}`).join('')}`;
};

export async function openSetup() {
  let r;
  try { r = await api('GET', '/api/setup'); } catch (e) { return fail(e); }
  const seen = () => { if (!S.settings.setupSeen) api('PUT', '/api/settings', { setupSeen: true }).then((s) => { S.settings = s; }).catch(() => {}); };
  await modal({
    title: t('Set up WhisperBrain'), wide: true, cls: 'setup-dlg',
    body: `<div id="su-body">${bodyHtml(r)}</div>`,
    foot: `<button class="btn" data-su-again>${icon('refresh', 'sm')} ${t('Check again')}</button><span class="spacer"></span><button class="btn primary" data-close>${t('Done')}</button>`,
    onMount: (d) => {
      d.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-copy]');
        if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => done(t('Copied')), fail); return; }
        if (e.target.closest('[data-close-setup]')) { d.close(); return; }
        if (e.target.closest('[data-su-again]')) {
          try { r = await api('GET', '/api/setup'); d.querySelector('#su-body').innerHTML = bodyHtml(r); S.state = await api('GET', '/api/state'); } catch (err) { fail(err); }
        }
      });
    },
  });
  seen();
  return r;
}

// First launch: show the list once, and only when something needs attention
export async function setupOnFirstRun() {
  if (S.settings.setupSeen) return;
  try {
    const r = await api('GET', '/api/setup');
    if (r.attention) await openSetup();
    else { S.settings = await api('PUT', '/api/settings', { setupSeen: true }); }
  } catch { /* the check is a convenience: never block the app */ }
}
