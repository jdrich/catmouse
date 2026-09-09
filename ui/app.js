const LEVELS = window.CATMOUSE_DUMMY?.levels ?? [
  { id: 1, name: 'canary' },
  { id: 2, name: 'disclosure' },
  { id: 3, name: 'fs-write' },
  { id: 4, name: 'tool-call' },
  { id: 5, name: 'exfil' },
  { id: 6, name: 'persist' },
  { id: 7, name: 'priv-esc' },
  { id: 8, name: 'takeover' },
];

let RUNS = [];
let catalog = { providers: {}, defaults: {} };
let TURN_LIMIT = 20;
const liveHits = new Set();

const logEl = document.getElementById('log');
const atkModelSel = document.getElementById('filter-atk-model');
const defModelSel = document.getElementById('filter-def-model');
const successSel = document.getElementById('filter-success');
const back = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalSub = document.getElementById('modal-sub');
const levelsEl = document.getElementById('levels');
const turnsEl = document.getElementById('turns');
const atkProvider = document.getElementById('atk-provider');
const atkModel = document.getElementById('atk-model');
const defProvider = document.getElementById('def-provider');
const defModel = document.getElementById('def-model');
const fireBtn = document.getElementById('fire');
const abortBtn = document.getElementById('abort');
const liveEl = document.getElementById('live');
const liveTitle = document.getElementById('live-title');
const liveLog = document.getElementById('live-log');
const liveStrip = document.getElementById('live-strip');
const mastSub = document.getElementById('mast-sub');

function fmt(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function strip(run) {
  const cells = LEVELS.map((L) => {
    const on = Boolean(run.levels?.[L.id]?.success);
    return `<span class="slot${on ? ' on' : ''}" title="L${L.id} ${L.name}"></span>`;
  }).join('');
  return `<span class="strip">${cells}</span>`;
}

function sideLabel(side, run) {
  const s = run[side] || {};
  return `${s.model || '?'}${s.thinking ? ` / ${s.thinking}` : ''}`;
}

function models(run) {
  return `def ${sideLabel('defender', run)}  ·  atk ${sideLabel('attacker', run)}`;
}

function uniqueField(side, field) {
  const set = new Set();
  for (const run of RUNS) {
    if (run.kind !== 'attack') continue;
    const v = run[side]?.[field];
    if (v) set.add(v);
  }
  return [...set].sort();
}

function highestSuccess(run) {
  if (run.kind !== 'attack') return 0;
  const levels = run.levels || {};
  let max = 0;
  for (const [id, rec] of Object.entries(levels)) {
    if (rec?.success) max = Math.max(max, Number(id));
  }
  return max;
}

function matchesFilters(run) {
  if (run.kind === 'adaptation') return true;
  if (atkModelSel.value && run.attacker?.model !== atkModelSel.value) return false;
  if (defModelSel.value && run.defender?.model !== defModelSel.value) return false;
  const cap = successSel.value;
  if (cap !== '' && highestSuccess(run) <= Number(cap)) return false;
  return true;
}

function fillSelect(el, blank, values, selected) {
  const cur = selected ?? el.value;
  el.innerHTML =
    `<option value="">${blank}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (cur && values.includes(cur)) el.value = cur;
}

function initFilters() {
  fillSelect(atkModelSel, 'all models', uniqueField('attacker', 'model'));
  fillSelect(defModelSel, 'all models', uniqueField('defender', 'model'));
  if (!successSel.dataset.ready) {
    successSel.innerHTML =
      `<option value="">any level</option>` +
      LEVELS.map((L) => `<option value="${L.id}">&gt; L${L.id} ${L.name}</option>`).join('');
    successSel.addEventListener('change', renderLog);
    atkModelSel.addEventListener('change', renderLog);
    defModelSel.addEventListener('change', renderLog);
    successSel.dataset.ready = '1';
  }
}

function renderLog() {
  logEl.innerHTML = '';
  let shown = 0;
  const rows = RUNS.slice().sort((a, b) => b.at.localeCompare(a.at));
  for (const run of rows) {
    if (!matchesFilters(run)) continue;
    shown++;
    if (run.kind === 'adaptation') {
      const el = document.createElement('div');
      el.className = 'row adaptation';
      el.innerHTML = `
        <div class="when">${fmt(run.at)}</div>
        <div class="kind">adapt</div>
        <div class="meta">
          <div class="models">${run.author || 'mouse'}</div>
          <div class="note">${escapeHtml(run.note)}</div>
        </div>
        <div></div>`;
      logEl.appendChild(el);
      continue;
    }

    const hit = highestSuccess(run) > 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `row attack ${run.status === 'running' ? 'live' : hit ? 'hit' : 'miss'}`;
    btn.innerHTML = `
      <div class="when">${fmt(run.at)}</div>
      <div class="kind">${run.status === 'running' ? 'live' : 'attack'}</div>
      <div class="meta">
        <div class="models">${escapeHtml(models(run))}</div>
        <div class="note">${escapeHtml(run.note || '')}</div>
      </div>
      ${strip(run)}`;
    btn.addEventListener('click', () => openRun(run, { follow: run.status === 'running' }));
    logEl.appendChild(btn);
  }
  if (!shown) {
    logEl.innerHTML = `<div class="empty">No runs yet. Pick models and fire.</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

let current = null;
let currentLevel = 1;
let followLive = true;
let watchingId = null;
let pollTimer = null;

function openRun(run, opts = {}) {
  current = run;
  followLive = Boolean(opts.follow);
  currentLevel = (followLive ? latestLevel(run) : firstLevelWithTurns(run)) || 1;
  paintModal(run);
  back.classList.add('open');
}

function paintModal(run) {
  const live = run.status === 'running' ? '  ·  live' : '';
  modalTitle.textContent = `${run.id}  ·  highest L${highestSuccess(run) || 0}${live}`;
  modalSub.textContent = `${fmt(run.at)}  ·  ${models(run)}`;
  renderLevels();
  renderTurns();
}

function latestLevel(run) {
  let max = 0;
  for (const L of LEVELS) {
    if (run.levels?.[L.id]?.turns?.length) max = L.id;
  }
  return max;
}

function countTurns(run) {
  let n = 0;
  for (const L of LEVELS) n += run.levels?.[L.id]?.turns?.length || 0;
  return n;
}

function upsertRun(run) {
  const i = RUNS.findIndex((r) => r.id === run.id);
  if (i >= 0) RUNS[i] = run;
  else RUNS.push(run);
}

function watchRun(id) {
  watchingId = id;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pullRun(id), 500);
  void pullRun(id);
}

function stopWatch() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  watchingId = null;
}

async function pullRun(id) {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const run = await res.json();
  const prev = current?.id === id ? countTurns(current) : 0;
  upsertRun(run);
  renderLog();
  if (current?.id === id && back.classList.contains('open')) {
    if (followLive) currentLevel = latestLevel(run) || currentLevel;
    current = run;
    paintModal(run);
    if (countTurns(run) > prev) turnsEl.scrollTop = turnsEl.scrollHeight;
  }
  if (run.status && run.status !== 'running') {
    stopWatch();
    setArmed(false);
    liveEl.hidden = false;
    liveTitle.textContent = run.status === 'done' ? `${run.id}  done` : run.note || run.status;
  }
}

function firstLevelWithTurns(run) {
  for (const L of LEVELS) {
    if (run.levels?.[L.id]?.turns?.length) return L.id;
  }
  return 1;
}

function renderLevels() {
  levelsEl.innerHTML = '';
  for (const L of LEVELS) {
    const rec = current.levels?.[L.id] || { success: false, turns: [] };
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `lvl${rec.success ? ' ok' : ''}${currentLevel === L.id ? ' on' : ''}`;
    const used = attackerTurns(rec);
    b.innerHTML = `<span>L${L.id} ${L.name}</span><span>${rec.success ? '●' : '○'} ${used}/${TURN_LIMIT}</span>`;
    b.addEventListener('click', () => {
      followLive = false;
      currentLevel = L.id;
      renderLevels();
      renderTurns();
    });
    levelsEl.appendChild(b);
  }
}

function levelMeta(id) {
  return LEVELS.find((L) => L.id === id) || { id, name: '', summary: '' };
}

function goalBanner(id) {
  const L = levelMeta(id);
  const rec = current.levels?.[id] || { success: false, turns: [] };
  const mark = rec.success ? 'HIT' : rec.turns?.length ? 'running' : 'queued';
  return `<div class="goal">
    <div class="goal-k">L${L.id} ${escapeHtml(L.name)} · ${mark}</div>
    <div class="goal-s">${escapeHtml(L.summary || '')}</div>
  </div>`;
}

function attackerTurns(rec) {
  return (rec?.turns || []).filter((t) => !t.probe).length;
}

function renderTurns() {
  const rec = current.levels?.[currentLevel] || { turns: [] };
  const turns = rec.turns || [];
  const head = goalBanner(currentLevel);
  if (!turns.length) {
    turnsEl.innerHTML = `${head}<div class="empty">No turns recorded for this level (0/${TURN_LIMIT}).</div>`;
    return;
  }
  turnsEl.innerHTML = head + turns
    .map((t, i) => {
      const tools = (t.toolCalls || [])
        .map((tc) => `${tc.name}(${tc.arguments})`)
        .join('\n');
      const attackText = stripBudget(t.attacker || t.payload || '');
      const payload = t.payload != null ? t.payload : '';
      const showPayload = payload && payload.trim() !== attackText.trim();
      const rem = remainingOf(t);
      if (t.probe) {
        return `<div class="turn probe">
        <div class="who">turn ${i + 1} · probe</div>
        <div class="who harness">harness → defender</div>
        <pre class="bubble harness">${escapeHtml(payload)}</pre>
        <div class="who mouse">defender</div>
        <pre class="bubble">${escapeHtml(t.defender ?? '∅  (tool-only)')}</pre>
        ${tools ? `<pre class="tools">${escapeHtml(tools)}</pre>` : ''}
      </div>`;
      }
      return `<div class="turn${t.reset ? ' reset' : ''}">
        <div class="who">turn ${i + 1}${t.reset ? ' · reset' : ''}</div>
        ${rem != null ? `<div class="who harness">harness → attacker</div><pre class="bubble harness">Turns remaining: ${rem} of ${TURN_LIMIT}.</pre>` : ''}
        <div class="who cat">attacker</div>
        <pre class="bubble">${escapeHtml(attackText || payload)}</pre>
        ${showPayload ? `<div class="who cat">payload → defender</div><pre class="bubble">${escapeHtml(payload)}</pre>` : ''}
        <div class="who mouse">defender</div>
        <pre class="bubble">${escapeHtml(t.defender ?? '∅  (tool-only)')}</pre>
        ${tools ? `<pre class="tools">${escapeHtml(tools)}</pre>` : ''}
      </div>`;
    })
    .join('');
}

function stripBudget(s) {
  return String(s || '')
    .replace(/^Turns remaining: \d+ of \d+\.\s*/i, '')
    .trim();
}

function remainingOf(t) {
  if (t.remaining != null) return t.remaining;
  const m = /Turns remaining: (\d+)/i.exec(t.attacker || '');
  return m ? Number(m[1]) : null;
}

function providerIds() {
  return Object.keys(catalog.providers || {});
}

function fillRole(providerEl, modelEl, role) {
  const ids = providerIds();
  const preferred = catalog.defaults?.[role]?.provider || '';
  fillSelect(providerEl, 'provider', ids, preferred);
  if (!providerEl.value && ids.includes(preferred)) providerEl.value = preferred;
  if (!providerEl.value && ids.length) providerEl.value = ids[0];
  fillRoleModels(providerEl, modelEl, role);
}

function fillRoleModels(providerEl, modelEl, role) {
  const row = catalog.providers?.[providerEl.value] || { models: [] };
  const models = row.models || [];
  const preferred = catalog.defaults?.[role]?.model || '';
  fillSelect(modelEl, models.length ? 'select model' : row.error || 'no models', models, preferred);
  if (preferred && models.includes(preferred)) modelEl.value = preferred;
  else if (!modelEl.value && models[0]) modelEl.value = models[0];
}

function clip(s, n = 180) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function paintLiveStrip() {
  liveStrip.innerHTML = LEVELS.map((L) => {
    const on = liveHits.has(L.id);
    return `<span class="slot${on ? ' on' : ''}" title="L${L.id} ${L.name}"></span>`;
  }).join('');
}

function liveLine(text) {
  liveLog.textContent = `${liveLog.textContent}${text}\n`.split('\n').slice(-80).join('\n');
  liveLog.scrollTop = liveLog.scrollHeight;
}

function setArmed(on) {
  fireBtn.disabled = on;
  liveEl.hidden = !on;
  abortBtn.disabled = !on;
}

async function fire() {
  const body = {
    attacker: { provider: atkProvider.value, model: atkModel.value },
    defender: { provider: defProvider.value, model: defModel.value },
  };
  if (!body.attacker.model || !body.defender.model) {
    liveEl.hidden = false;
    liveTitle.textContent = 'pick both models';
    return;
  }
  liveHits.clear();
  paintLiveStrip();
  liveLog.textContent = '';
  setArmed(true);
  liveTitle.textContent = 'ignition…';
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    setArmed(false);
    liveEl.hidden = false;
    liveTitle.textContent = 'misfire';
    liveLine(data.error || res.statusText);
    return;
  }
  liveTitle.textContent = data.id;
  liveLine(`cat ${body.attacker.provider}/${body.attacker.model}`);
  liveLine(`mouse ${body.defender.provider}/${body.defender.model}`);
  const stub = {
    id: data.id,
    at: new Date().toISOString(),
    kind: 'attack',
    status: 'running',
    attacker: body.attacker,
    defender: body.defender,
    successes: 0,
    note: 'running',
    levels: {},
  };
  upsertRun(stub);
  renderLog();
  openRun(stub, { follow: true });
  watchRun(data.id);
}

function onEvent(event) {
  if (event.type === 'hello' && event.current?.id) {
    setArmed(true);
    liveTitle.textContent = event.current.id;
  }
  if (event.type === 'start') {
    setArmed(true);
    liveHits.clear();
    paintLiveStrip();
    liveTitle.textContent = event.run.id;
    liveLine(`start ${event.run.id}`);
  }
  if (event.type === 'turn') {
    liveTitle.textContent = `L${event.level} ${event.name}  ·  turn ${event.turnsUsed}/${TURN_LIMIT}${event.success ? '  HIT' : ''}`;
    if (event.success) {
      liveHits.add(event.level);
      paintLiveStrip();
    }
  }
  if (event.type === 'level') {
    if (event.success) liveHits.add(event.level);
    paintLiveStrip();
    liveLine(`L${event.level} ${event.name} — ${event.success ? 'HIT' : 'miss'}  ${event.turnsUsed}/${TURN_LIMIT}`);
  }
  if (event.type === 'done' || event.type === 'error') {
    setArmed(false);
    liveEl.hidden = false;
    liveTitle.textContent = event.type === 'done' ? `${event.run.id}  done` : event.message;
    if (event.type === 'error') liveLine(event.message);
    void refreshRuns();
  }
}

async function refreshRuns() {
  try {
    const res = await fetch('/api/runs');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    RUNS = data.runs || [];
    mastSub.textContent = `${RUNS.length} runs · ${TURN_LIMIT}-turn budget · 8 levels`;
  } catch {
    RUNS = window.CATMOUSE_DUMMY?.runs?.slice() || [];
    mastSub.textContent = `dummy runs · ${TURN_LIMIT}-turn budget · 8 levels`;
  }
  initFilters();
  renderLog();
}

async function loadCatalog() {
  const res = await fetch('/api/models?refresh=1');
  if (!res.ok) throw new Error(`models ${res.status}`);
  catalog = await res.json();
  if (catalog.turnLimit) TURN_LIMIT = catalog.turnLimit;
  if (Array.isArray(catalog.levels)) {
    for (const row of catalog.levels) {
      const L = LEVELS.find((x) => x.id === row.id);
      if (L) Object.assign(L, row);
    }
  }
  fillRole(atkProvider, atkModel, 'attacker');
  fillRole(defProvider, defModel, 'defender');
}

document.getElementById('close').addEventListener('click', () => back.classList.remove('open'));
back.addEventListener('click', (e) => {
  if (e.target === back) back.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') back.classList.remove('open');
});
atkProvider.addEventListener('change', () => fillRoleModels(atkProvider, atkModel, 'attacker'));
defProvider.addEventListener('change', () => fillRoleModels(defProvider, defModel, 'defender'));
fireBtn.addEventListener('click', () => void fire());
abortBtn.addEventListener('click', () => {
  void fetch('/api/runs/abort', { method: 'POST' });
});

const events = new EventSource('/api/events');
events.onmessage = (ev) => {
  try {
    onEvent(JSON.parse(ev.data));
  } catch {
    /* ignore */
  }
};

void (async function boot() {
  try {
    await loadCatalog();
  } catch (err) {
    liveEl.hidden = false;
    liveTitle.textContent = 'models failed';
    liveLine(err instanceof Error ? err.message : String(err));
  }
  await refreshRuns();
})();
