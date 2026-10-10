'use strict';

const CATS = ['read', 'edit', 'run', 'web', 'agent', 'mcp', 'plan', 'ask', 'other'];
const CAT_NAMES = { read: 'Read / search', edit: 'Edit', run: 'Shell', web: 'Web', agent: 'Subagent', mcp: 'MCP', plan: 'Plan', ask: 'Ask', other: 'Other' };
const STATUS_LABEL = { working: 'WORKING', waiting: 'NEEDS YOU', idle: 'IDLE', offline: 'ENDED', done: 'DONE' };
const STATUS_ORDER = { waiting: 0, working: 1, idle: 2, done: 3, offline: 4 };
const MAX_EVENTS = 600;

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CAT_COLOR = Object.fromEntries(CATS.map((c) => [c, cssVar('--c-' + c)]));
const COLOR = { error: cssVar('--c-error'), working: cssVar('--working'), text: cssVar('--text') };

const store = {
  get: (k, d) => { try { return localStorage.getItem('hub.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('hub.' + k, v); } catch { /* storage unavailable */ } },
};

const state = {
  agents: [],                // shown agents (all, or one machine's in hub mode)
  allAgents: [],
  others: [],
  machines: null,            // hub mode: [{ id, name, online, share, … }]; '@local' is this PC
  machine: store.get('machine', ''), // machine filter, '' = all
  reporting: null,           // this PC reports to a hub: { to, share, state, error }
  host: '',
  projectsOn: true,          // false for viewers coming through a proxy or the network
  byKey: new Map(),          // agent or subagent key -> summary (subagents get .parent)
  events: new Map(),         // key -> events[]
  seen: new Map(),           // key -> Set(event id)
  tools: new Map(),          // toolId -> tool event (results attach to it)
  expanded: new Set(),
  prevStatus: new Map(),
  selected: store.get('sel', null),
  rangeMin: Number(store.get('range', 10)),
  showEnded: store.get('ended', '0') === '1',
  notify: store.get('notify', '0') === '1' && 'Notification' in window && Notification.permission === 'granted',
  laneKeys: '',
  detailKey: null,
  sendEpoch: null,           // id of the server run when it was started with --allow-send, else null
  sendToken: null,           // this tab's send token, once unlocked
  unlockError: '',
};

// --allow-send: the CLI opens (or prints) a one-use link with #send=<code>. Take the code out of the
// address bar before the router sees it; the tab trades it for its own token once connected.
// The token lives in sessionStorage, so it survives reloads of this tab only.
let unlockCode = null;
function takeUnlockCode() {
  const code = location.hash.match(/^#send=([0-9a-f]{64})$/)?.[1];
  if (!code) return false;
  unlockCode = code;
  history.replaceState(null, '', location.pathname + location.search + '#/');
  return true;
}
takeUnlockCode();
// A link pasted into an open dashboard tab only changes the hash. This listener runs before the
// router's (projects.js loads later), so the router then sees the cleaned-up '#/'.
window.addEventListener('hashchange', () => {
  if (takeUnlockCode() && state.sendEpoch && !state.sendToken) unlockSending();
});
const tabSend = {
  get: () => { try { return JSON.parse(sessionStorage.getItem('hub.send')); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem('hub.send', JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function unlockSending() {
  const code = unlockCode;
  unlockCode = null;
  try {
    const r = await fetch('/api/send/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    tabSend.set({ token: d.token, epoch: d.epoch });
    state.sendToken = d.epoch === state.sendEpoch ? d.token : null;
    state.unlockError = '';
  } catch (e) {
    state.unlockError = e.message;
  }
  for (const host of document.querySelectorAll('#compose, #fl-compose')) delete host.dataset.sig;
  renderDetail();
  renderCanvas();
}

const $ = (s) => document.querySelector(s);
// Who wrote a prompt: you, you through Agent Hub's message box, another session, or a subagent's task.
// `a` is the agent or subagent; on a hub, prompts typed on another machine are a USER's.
const promptWho = (e, a) => (a.parent ? 'TASK' : e.from === 'agent-hub' ? 'YOU · HUB' : e.from ? 'SESSION' : a.remote ? 'USER' : 'YOU');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : fmtDur(ms));
const fmtK = (n) => (!n ? '0' : n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`);
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function shortModel(m) {
  const x = /claude-(\w+)-(\d+)-(\d+)/.exec(m || '');
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : (m || '—');
}
// Hub mode: which machine an agent runs on. Agents of this PC have no `machine`.
const machineOf = (a) => (a.parent ? a.parent : a).machine || '@local';
const machineName = (a) => (a.parent ? a.parent : a).machine || state.host;
function nowText(a) {
  const n = a.now || {};
  if (n.cat === 'mcp') return [n.label, n.summary].filter(Boolean).join(' · ');
  return n.summary || (n.label && n.verb !== 'Thinking' ? n.label : '') || '';
}

/* ---------------- data ---------------- */

function addEvents(key, events) {
  let arr = state.events.get(key);
  let seen = state.seen.get(key);
  if (!arr) { arr = []; seen = new Set(); state.events.set(key, arr); state.seen.set(key, seen); }
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.kind === 'result') {
      const tool = state.tools.get(e.toolId);
      if (tool) tool.result = e;
      continue;
    }
    if (e.kind === 'tool') state.tools.set(e.toolId, e);
    arr.push(e);
  }
  if (arr.length > MAX_EVENTS) {
    for (const e of arr.splice(0, arr.length - MAX_EVENTS)) {
      seen.delete(e.id);
      if (e.kind === 'tool') state.tools.delete(e.toolId);
    }
  }
}

function setAgents(agents) {
  agents.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.lastAt - a.lastAt));
  state.allAgents = agents;
  // Filtering by machine only hides cards; every agent stays in byKey so its events are kept.
  state.agents = state.machines && state.machine ? agents.filter((a) => machineOf(a) === state.machine) : agents;
  state.byKey = new Map();
  for (const a of agents) {
    state.byKey.set(a.key, a);
    for (const s of a.subagents) { s.parent = a; s.name = s.type; state.byKey.set(s.key, s); }
  }
  for (const k of [...state.events.keys()]) {
    if (!state.byKey.has(k)) { state.events.delete(k); state.seen.delete(k); }
  }
  for (const a of agents) {
    const prev = state.prevStatus.get(a.key);
    if (prev === 'working' && (a.status === 'idle' || a.status === 'waiting')) {
      notify(`${a.name} ${a.status === 'waiting' ? 'needs you' : 'finished'}`, a.now?.summary || a.lastSay?.text || '');
    }
    state.prevStatus.set(a.key, a.status);
  }
  const shown = state.byKey.get(state.selected);
  if (!shown || !state.agents.includes(shown.parent || shown)) {
    state.selected = state.agents.find((a) => a.status === 'working')?.key || state.agents[0]?.key || null;
  }
  renderAll();
}

function setMachines(machines) {
  state.machines = machines;
  if (state.machine && !machines?.some((m) => m.id === state.machine)) state.machine = '';
  renderMachines();
}

function pickMachine(id) {
  state.machine = id;
  store.set('machine', id);
  setAgents(state.allAgents);
  renderMachines();
  renderOthers();
}

/* ---------------- header ---------------- */

function renderCounters() {
  const live = state.agents.filter((a) => a.live);
  const count = (s) => live.filter((a) => a.status === s).length;
  const subs = live.flatMap((a) => a.subagents).filter((s) => s.status === 'working').length;
  const waiting = count('waiting');
  $('#counters').innerHTML = `
    <span class="ctr working"><b>${count('working')}</b> working</span>
    <span class="ctr waiting ${waiting ? 'hot' : ''}"><b>${waiting}</b> need you</span>
    <span class="ctr"><b>${count('idle')}</b> idle</span>
    <span class="ctr"><b>${subs}</b> subagents active</span>
    <span class="ctr"><b>${visibleOthers().length}</b> other tools</span>`;
  const w = count('working');
  document.title = `${waiting ? '⚠ ' : ''}${w ? `(${w}) ` : ''}Agent Hub`;
}

function setConn(on, host) {
  $('#conn').classList.toggle('on', on);
  $('#conn span').textContent = on ? 'live' : 'reconnecting';
  if (host) state.host = host;
  renderHost();
}

function renderHost() {
  const ms = state.machines;
  $('#host').textContent = ms
    ? `${state.host} · hub · ${ms.filter((m) => m.online).length}/${ms.length} machines online`
    : state.host || 'connecting…';
}

/* ---------------- hub: machines and reporting ---------------- */

const NOT_SHARED = '(not shared by that machine)';
const SHARE_NOTE = {
  metadata: 'Shared at the metadata level: no prompts, replies, titles or tool details leave that machine.',
  activity: 'Shared at the activity level: tool summaries and plans, but no prompts, replies or tool output.',
};

function renderMachines() {
  const ms = state.machines;
  const pick = $('#machine-pick');
  pick.hidden = !ms;
  $('#machines-h').hidden = !ms;
  $('#machines').hidden = !ms;
  $('#others-h').textContent = ms ? 'Other AI tools' : 'Other AI tools on this PC';
  renderHost();
  if (!ms) return;
  const options = `<option value="">All machines</option>${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.local ? ' (this PC)' : m.online ? '' : ' (offline)'}</option>`).join('')}`;
  if (pick._html !== options) { pick.innerHTML = options; pick._html = options; }
  pick.value = state.machine;
  const liveOn = (id) => state.allAgents.filter((a) => a.live && machineOf(a) === id).length;
  $('#machines').innerHTML = ms.map((m) => `
    <div class="other machine ${state.machine === m.id ? 'on' : ''}" data-machine="${esc(m.id)}" title="${esc(m.local ? 'This PC' : `${m.host || ''} · agent-hub-ui ${m.version || '?'}`)}">
      <span class="dot ${!m.online ? '' : liveOn(m.id) ? 's-working' : 's-idle'}"></span>
      <div><div class="nm">${esc(m.name)}${m.local ? ' <span class="tag">this PC</span>' : ''}</div>
      <div class="m">${liveOn(m.id)} running${m.local ? '' : ` · ${esc(m.share || '')}`}${m.online ? '' : ` · offline, last seen <span data-since="${Number(m.lastSeen) || 0}"></span> ago`}</div></div>
    </div>`).join('');
}

function renderReporting() {
  const r = state.reporting;
  const el = $('#reporting');
  el.hidden = !r;
  if (!r) return;
  el.className = `reporting ${r.state === 'ok' ? 'ok' : r.state === 'error' ? 'err' : ''}`;
  el.textContent = `Reporting to ${r.to.replace(/^https?:\/\//, '')} · ${r.share}`;
  el.title = r.state === 'error' ? r.error : `This PC sends its agents' activity to a hub at the "${r.share}" level.`;
}

function visibleOthers() {
  return state.machines && state.machine ? state.others.filter((o) => (o.machine || '@local') === state.machine) : state.others;
}

/* ---------------- cards ---------------- */

function cardHTML(a) {
  const n = a.now || {};
  const subs = a.subagents.filter((s) => s.status === 'working' || Date.now() - s.lastAt < 30 * 60e3);
  return `
  <article class="card s-${a.status} ${a.key === state.selected ? 'sel' : ''}" data-key="${esc(a.key)}">
    <div class="card-top">
      <span class="dot"></span><span class="status">${STATUS_LABEL[a.status] || a.status}</span>
      ${a.kind === 'bg' ? '<span class="tag">background</span>' : ''}
      <span class="spacer"></span>
      <span title="Last activity">${a.lastAt ? `<span data-since="${a.lastAt}"></span> ago` : ''}</span>
    </div>
    <h3 title="${esc(a.title || a.name)}">${esc(a.name)}</h3>
    <div class="where">${state.machines ? `<span class="machine" title="Machine">⌂ ${esc(machineName(a))}</span>` : ''}<span title="${esc(a.cwd)}">${esc(a.project || '—')}</span>${a.branch ? `<span class="branch">⎇ ${esc(a.branch)}</span>` : ''}</div>
    <div class="now c-${n.cat || 'other'}">
      <span class="verb">${esc(n.verb || '')}</span>
      <span class="what" title="${esc(nowText(a))}">${esc(nowText(a))}</span>
      ${a.status === 'working' && n.since ? `<span class="timer" data-since="${n.since}"></span>` : ''}
    </div>
    ${a.status !== 'working' && a.lastPrompt ? `<p class="latest">› ${esc(a.lastPrompt)}</p>` : ''}
    ${subs.length ? `<div class="chips">${subs.map((s) => `<span class="chip-sub s-${s.status}" title="${esc(s.description)}"><span class="dot"></span>${esc(s.type)}</span>`).join('')}</div>` : ''}
    <footer class="stats">
      <span><b>${shortModel(a.model)}</b></span>
      <span>ctx <b>${fmtK(a.context)}</b></span>
      <span>out <b>${fmtK(a.outTokens)}</b></span>
      <span><b>${a.toolCount}</b> tools</span>
      ${a.pid ? `<span>pid <b>${a.pid}</b></span>` : ''}
    </footer>
  </article>`;
}

function renderCards() {
  const live = state.agents.filter((a) => a.live);
  const ended = state.agents.filter((a) => !a.live);
  $('#cards').innerHTML = live.length ? live.map(cardHTML).join('') : '<div class="others"><span class="none">No Claude Code sessions are running right now.</span></div>';
  $('#recent').innerHTML = ended.map(cardHTML).join('');
  $('#recent-h').hidden = !ended.length;
  $('#floor-count').textContent = `${live.length} running`;
}

function pulse(key) {
  const top = key.split('/')[0];
  const el = document.querySelector(`.card[data-key="${CSS.escape(top)}"]`);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

function renderOthers() {
  const others = visibleOthers();
  $('#others').innerHTML = others.length
    ? others.map((o) => `
      <div class="other" title="${esc(o.cmd)}">
        <span class="dot s-idle"></span>
        <div><div class="nm">${esc(o.label)}${state.machines ? ` <span class="tag">${esc(o.machine || state.host)}</span>` : ''}</div>
        <div class="m">${o.pids.length} process${o.pids.length > 1 ? 'es' : ''} · ${fmtBytes(o.memory)}${o.startedAt ? ` · up <span data-since="${o.startedAt}"></span>` : ''}</div></div>
      </div>`).join('')
    : '<span class="none">None running. Watching for Cursor, Windsurf, Copilot CLI, Codex CLI, Gemini CLI, Aider, opencode, Goose, Claude Desktop, Ollama and LM Studio.</span>';
}

/* ---------------- swimlanes ---------------- */

function laneRows() {
  const winStart = Date.now() - state.rangeMin * 60e3;
  const active = (key) => (state.events.get(key) || []).some((e) => e.t >= winStart);
  const rows = [];
  for (const a of state.agents) {
    if (!a.live && (!active(a.key) || (!state.showEnded && a.key !== state.selected))) continue;
    rows.push({ key: a.key, a, sub: false });
    for (const s of a.subagents) {
      if (s.status === 'working' || active(s.key)) rows.push({ key: s.key, a: s, sub: true });
    }
  }
  return rows;
}

function renderLanes() {
  const rows = laneRows();
  const keys = rows.map((r) => r.key).join('|');
  const host = $('#lanes');
  if (keys !== state.laneKeys) {
    state.laneKeys = keys;
    host.innerHTML = rows.length ? rows.map((r) => `
      <div class="lane ${r.sub ? 'sub' : ''}" data-key="${esc(r.key)}">
        <div class="lane-label"><span class="dot"></span><div class="lane-text"><div class="lane-name"></div><div class="lane-now"></div></div></div>
        <canvas></canvas>
      </div>`).join('') : '<div class="none">No live agents in this window.</div>';
  }
  for (const r of rows) {
    const el = host.querySelector(`.lane[data-key="${CSS.escape(r.key)}"]`);
    if (!el) continue;
    el.classList.toggle('sel', r.key === state.selected);
    el.querySelector('.dot').className = `dot s-${r.a.status}`;
    el.querySelector('.lane-name').textContent = r.sub
      ? `${r.a.type}${r.a.description ? ' · ' + r.a.description : ''}`
      : `${state.machines ? `${machineName(r.a)} · ` : ''}${r.a.name}`;
    const n = r.a.now || {};
    el.querySelector('.lane-now').textContent = `${n.verb || ''} ${nowText(r.a)}`.trim();
  }
}

function renderAxis() {
  const win = state.rangeMin * 60e3;
  const n = 5;
  const labels = [];
  for (let i = 0; i <= n; i++) {
    const left = (i / n) * 100;
    labels.push(`<span style="left:${left}%">${i === n ? 'now' : '-' + fmtDur(Math.round((win * (1 - i / n)) / 1000) * 1000).replace(/ 00s| 00m/, '')}</span>`);
  }
  $('#axis').innerHTML = `<div></div><div class="ticks">${labels.join('')}</div>`;
}

function drawLanes() {
  const now = Date.now();
  const win = state.rangeMin * 60e3;
  const t0 = now - win;
  const step = win <= 2 * 60e3 ? 15e3 : win <= 10 * 60e3 ? 60e3 : win <= 30 * 60e3 ? 5 * 60e3 : 15 * 60e3;
  for (const lane of document.querySelectorAll('.lane')) {
    const cv = lane.querySelector('canvas');
    const agent = state.byKey.get(lane.dataset.key);
    if (!cv || !agent) continue;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const X = (t) => ((t - t0) / win) * w;

    g.fillStyle = 'rgba(255,255,255,0.035)';
    for (let t = Math.ceil(t0 / step) * step; t < now; t += step) g.fillRect(Math.round(X(t)), 0, 1, h);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, Math.round(h / 2), w, 1);

    const working = agent.status === 'working';
    const hits = [];
    for (const e of state.events.get(lane.dataset.key) || []) {
      if (e.kind === 'tool') {
        const end = e.result ? e.t + Math.max(e.result.ms || 0, 0) : working ? now : e.t;
        if (end < t0) continue;
        const x0 = X(e.t);
        const x1 = Math.max(x0 + 3, X(end));
        g.globalAlpha = e.result ? 0.9 : 1;
        g.fillStyle = CAT_COLOR[e.cat] || CAT_COLOR.other;
        if (!e.result && working) { g.shadowColor = g.fillStyle; g.shadowBlur = 10; }
        g.beginPath();
        g.roundRect(x0, 8, x1 - x0, h - 16, 2);
        g.fill();
        g.shadowBlur = 0;
        if (e.result && !e.result.ok) { g.fillStyle = COLOR.error; g.fillRect(x0, 2, Math.max(3, x1 - x0), 4); }
        g.globalAlpha = 1;
        hits.push({ x0, x1, e });
      } else if (e.t >= t0 && (e.kind === 'prompt' || e.kind === 'say')) {
        const x = X(e.t);
        if (e.kind === 'prompt') {
          g.fillStyle = COLOR.text;
          g.fillRect(x - 0.75, 0, 1.5, h);
          g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5); g.fill();
        } else {
          g.fillStyle = 'rgba(219,226,236,.6)';
          g.beginPath(); g.arc(x, h - 3.5, 2.2, 0, Math.PI * 2); g.fill();
        }
        hits.push({ x0: x - 3, x1: x + 3, e });
      }
    }
    if (working) {
      g.globalAlpha = 0.45 + 0.45 * Math.sin(now / 250);
      g.fillStyle = COLOR.working;
      g.fillRect(w - 2, 0, 2, h);
      g.globalAlpha = 1;
    }
    cv._hits = hits;
  }
}

function laneTip(ev) {
  const cv = ev.target;
  const tip = $('#tip');
  if (!(cv instanceof HTMLCanvasElement) || !cv._hits) { tip.hidden = true; return; }
  const x = ev.offsetX;
  const hit = [...cv._hits].reverse().find((h) => x >= h.x0 - 2 && x <= h.x1 + 2);
  if (!hit) { tip.hidden = true; return; }
  const e = hit.e;
  if (e.kind === 'tool') {
    const r = e.result;
    const st = r ? `${r.ok ? 'done' : 'failed'} in ${fmtMs(r.ms)}` : 'running';
    tip.innerHTML = `<b style="color:${CAT_COLOR[e.cat]}">${esc(e.label)}</b> ${esc(e.summary)}<div class="m">${fmtTime(e.t)} · ${st}</div>`;
  } else {
    tip.innerHTML = `<b>${e.kind === 'prompt' ? promptWho(e, state.byKey.get(cv.parentElement?.dataset.key) || {}) : 'Agent'}</b> ${esc(e.text.slice(0, 220))}<div class="m">${fmtTime(e.t)}</div>`;
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(ev.clientX + 14, innerWidth - r.width - 10)}px`;
  tip.style.top = `${ev.clientY + 16}px`;
}

/* ---------------- detail ---------------- */

function detailHeadHTML(a) {
  const n = a.now || {};
  const isSub = !!a.parent;
  const kv = (k, v, title) => (v ? `<dt>${k}</dt><dd title="${esc(title ?? v)}">${esc(v)}</dd>` : '');
  let html = `<div class="d-head s-${a.status}">`;
  if (isSub) html += `<button class="back" data-select="${esc(a.parent.key)}">← ${esc(a.parent.name)}</button>`;
  html += `
    <div class="card-top">
      <span class="dot"></span><span class="status">${STATUS_LABEL[a.status] || a.status}</span>
      ${isSub ? '<span class="tag">subagent</span>' : a.kind === 'bg' ? '<span class="tag">background</span>' : ''}
    </div>
    <h3>${esc(isSub ? a.type : a.name)}</h3>
    ${isSub && a.description ? `<div class="d-title">${esc(a.description)}</div>` : ''}
    ${!isSub && a.title && a.title !== a.name ? `<div class="d-title">${esc(a.title)}</div>` : ''}
    <div class="now c-${n.cat || 'other'}">
      <span class="verb">${esc(n.verb || '')}</span>
      <span class="what" title="${esc(nowText(a))}">${esc(nowText(a))}</span>
      ${a.status === 'working' && n.since ? `<span class="timer" data-since="${n.since}"></span>` : ''}
    </div>
    <dl class="kv">
      ${!isSub && state.machines ? kv('Machine', machineName(a)) : ''}
      ${isSub || !a.cwd || a.remote || !state.projectsOn ? '' : `<dt>Folder</dt><dd title="${esc(a.cwd)}"><a href="#/projects/${encodeURIComponent(a.cwd.replace(/[^a-zA-Z0-9]/g, '-'))}">${esc(a.cwd)}</a></dd>`}
      ${!isSub && (a.remote || !state.projectsOn) ? kv('Folder', a.cwd || a.project) : ''}
      ${isSub ? '' : kv('Branch', a.branch)}
      ${kv('Model', a.model)}
      <dt>Context</dt><dd>${fmtK(a.context)} tokens</dd>
      <dt>Output</dt><dd>${fmtK(a.outTokens)} tokens · ${a.toolCount} tool calls</dd>
      ${a.startedAt ? `<dt>Started</dt><dd>${fmtTime(a.startedAt)} · <span data-since="${a.startedAt}"></span> ago</dd>` : ''}
      ${!isSub && a.pid ? kv('Process', `pid ${a.pid}${a.version ? ' · v' + a.version : ''}`) : ''}
      ${!isSub ? kv('Session', a.sessionId) : ''}
    </dl>
    ${(a.parent || a).remote && SHARE_NOTE[(a.parent || a).share] ? `<div class="share-note">${esc(SHARE_NOTE[(a.parent || a).share])}</div>` : ''}
    ${!isSub && a.prs?.length ? `<div class="chips">${a.prs.map((p) => `<a class="chip-sub" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">PR #${esc(p.number)}</a>`).join('')}</div>` : ''}
  </div>`;

  if (!isSub && a.job && (a.job.detail || a.job.fan?.length)) {
    html += `<div class="d-section"><h4>Background job · ${esc(a.job.state || '')}</h4>
      ${a.job.detail ? `<div style="font-size:13px">${esc(a.job.detail)}</div>` : ''}
      ${a.job.fan?.length ? `<div class="bg-tasks" style="margin-top:6px">${a.job.fan.map((f) => `<div title="${esc(f.label)}">▸ ${esc(f.kind)}: ${esc(f.label)} · <span data-since="${Number(f.startedAt) || 0}"></span></div>`).join('')}</div>` : ''}
    </div>`;
  }
  if (!isSub && a.todos?.length) {
    const done = a.todos.filter((t) => t.status === 'completed').length;
    html += `<div class="d-section"><h4>Plan · ${done}/${a.todos.length}</h4><ul class="todos">
      ${a.todos.map((t) => `<li class="${esc(t.status)}">${esc(t.content)}</li>`).join('')}</ul></div>`;
  }
  if (!isSub && a.subagents.length) {
    html += `<div class="d-section"><h4>Subagents</h4><div class="sub-list">
      ${a.subagents.map((s) => `
        <div class="sub-row s-${s.status}" data-select="${esc(s.key)}">
          <span class="dot"></span><span>${esc(s.type)}</span>
          <span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.description)}</span>
          <span class="m">${s.status === 'working' ? esc(s.now?.verb || '') : STATUS_LABEL[s.status]} · ${s.toolCount} tools</span>
        </div>`).join('')}</div></div>`;
  }
  return html;
}

function eventHTML(e, a) {
  const time = `<span class="ev-time">${fmtTime(e.t)}</span>`;
  switch (e.kind) {
    case 'tool': {
      const r = e.result;
      const open = state.expanded.has(e.id);
      const st = r
        ? `<span class="ev-st ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}</span>`
        : a.status === 'working'
          ? `<span class="ev-st run">● <span data-since="${e.t}"></span></span>`
          : '<span class="ev-st">—</span>';
      return `<div class="ev ev-tool c-${e.cat}" data-id="${esc(e.id)}">
        <div class="ev-row">${time}<span class="chip">${esc(e.label)}</span><span class="ev-sum">${esc(e.summary)}</span>${st}</div>
        ${open ? `<pre>${esc(e.detail ?? NOT_SHARED)}</pre>${r ? `<pre class="res ${r.ok ? '' : 'err'}">${esc(r.text ?? NOT_SHARED) || '(no output)'}</pre>` : ''}` : ''}
      </div>`;
    }
    case 'say':
      return `<div class="ev ev-say"><div class="ev-row">${time}</div>
        <div class="body ${state.expanded.has(e.id) ? '' : 'clamp'}" data-id="${esc(e.id)}">${esc(e.text)}</div></div>`;
    case 'prompt':
      return `<div class="ev ev-prompt"><div class="ev-row"><span class="who">${promptWho(e, a)}</span>${time}</div>
        <div class="body">${esc(e.text)}</div></div>`;
    case 'pr':
      return `<div class="ev ev-pr"><div class="ev-row">${time}<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.text)}</a></div></div>`;
    default:
      return `<div class="ev ev-note">— ${esc(e.text)} · ${fmtTime(e.t)} —</div>`;
  }
}

function renderDetail() {
  const a = state.byKey.get(state.selected);
  const host = $('#detail');
  if (!a) {
    state.detailKey = null;
    host.innerHTML = '<div class="empty">Select an agent to follow what it\'s doing.</div>';
    return;
  }
  if (state.detailKey !== a.key) {
    state.detailKey = a.key;
    host.innerHTML = `<div id="d-top"></div>
      <div id="compose"></div>
      <div class="feed-h"><h4 style="margin:0;font:600 11px var(--mono);letter-spacing:.1em;color:var(--dim)">TIMELINE · NEWEST FIRST</h4><span class="ev-time" id="feed-count"></span></div>
      <div class="feed" id="feed"></div>`;
  }
  $('#d-top').innerHTML = detailHeadHTML(a);
  renderCompose($('#compose'), a);
  renderFeed();
}

// Message box for agent `a` (or none) in `host`; used by the detail panel and the canvas chat panel.
// Rebuilt only when the agent or what it shows changes, so a half-typed message survives updates.
function renderCompose(host, a) {
  const mode = !a || a.parent || !a.canMessage ? 'none' : state.sendToken ? 'form' : state.sendEpoch ? 'locked' : 'off';
  const sig = `${mode}:${a?.key || ''}:${state.unlockError}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.dataset.key = a?.key || '';
  host.className = mode === 'none' ? '' : 'compose';
  host.innerHTML = mode === 'form'
    ? `<form class="compose-form">
        <textarea rows="2" maxlength="20000" placeholder="Message this session… (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="compose-row"><span class="compose-msg"></span><button class="btn" type="submit">Send</button></div>
      </form>`
    : mode === 'off'
      ? '<div class="compose-msg">To message this session from here, start Agent Hub with <code>--allow-send</code>.</div>'
      : mode === 'locked'
        ? `<div class="compose-msg ${state.unlockError ? 'err' : ''}">${state.unlockError
          ? esc(state.unlockError)
          : 'Messaging is on, but not in this tab. Open the one-use link Agent Hub printed in its terminal.'}</div>`
        : '';
}

async function sendMessage(form) {
  const key = form.closest('[data-key]')?.dataset.key;
  const box = form.querySelector('textarea');
  const msg = form.querySelector('.compose-msg');
  const text = box.value.trim();
  if (!key || !text || form.classList.contains('busy')) return;
  form.classList.add('busy');
  msg.className = 'compose-msg';
  msg.textContent = 'Sending…';
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Hub-Token': state.sendToken },
      body: JSON.stringify({ key, text }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    box.value = '';
    // The socket gives no delivery receipt; the transcript does, as a YOU · HUB timeline entry.
    msg.textContent = 'Sent. It appears in the timeline once the session takes it.';
  } catch (e) {
    msg.classList.add('err');
    msg.textContent = e.message;
  }
  form.classList.remove('busy');
}

function renderFeed() {
  const a = state.byKey.get(state.selected);
  const feed = $('#feed');
  if (!a || !feed) return;
  const events = (state.events.get(a.key) || []).slice(-250).reverse();
  const prevH = feed.scrollHeight;
  const prevTop = feed.scrollTop;
  feed.innerHTML = events.length ? events.map((e) => eventHTML(e, a)).join('') : '<div class="ev ev-note">No activity recorded yet.</div>';
  if (prevTop > 0) feed.scrollTop = prevTop + (feed.scrollHeight - prevH);
  $('#feed-count').textContent = `${events.length} events`;
  updateTimers(feed);
}

/* ---------------- misc ---------------- */

function updateTimers(root = document) {
  const now = Date.now();
  for (const el of root.querySelectorAll('[data-since]')) el.textContent = fmtDur(now - Number(el.dataset.since));
}

function select(key) {
  if (!key || !state.byKey.has(key)) return;
  state.selected = key;
  store.set('sel', key);
  renderCards();
  renderLanes();
  renderDetail();
  updateTimers();
}

function notify(title, body) {
  if (!state.notify || !document.hidden) return;
  try { new Notification(title, { body: body.slice(0, 200), tag: title }); } catch { /* unsupported */ }
}

function renderNotifyBtn() {
  const b = $('#notify');
  b.classList.toggle('on', state.notify);
  b.textContent = state.notify ? 'Notifications on' : 'Notifications off';
}

function renderAll() {
  renderCounters();
  renderCards();
  renderLanes();
  renderDetail();
  renderCanvas();
  updateTimers();
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('init', (m) => {
    const d = JSON.parse(m.data);
    state.events.clear(); state.seen.clear(); state.tools.clear();
    for (const [k, evs] of Object.entries(d.events)) addEvents(k, evs);
    state.others = d.others || [];
    state.sendEpoch = d.send || null;
    const saved = tabSend.get();
    state.sendToken = state.sendEpoch && saved?.epoch === state.sendEpoch ? saved.token : null;
    if (unlockCode && state.sendEpoch && !state.sendToken) unlockSending();
    for (const host of document.querySelectorAll('#compose, #fl-compose')) delete host.dataset.sig;
    state.reporting = d.reporting || null;
    state.projectsOn = d.projects !== false;
    $('#tabs a[data-view="projects"]').hidden = !state.projectsOn;
    renderReporting();
    setConn(true, d.host);
    setMachines(d.machines || null);
    renderOthers();
    setAgents(d.agents);
  });
  es.addEventListener('agents', (m) => { setAgents(JSON.parse(m.data)); if (state.machines) renderMachines(); });
  es.addEventListener('machines', (m) => { setMachines(JSON.parse(m.data)); setAgents(state.allAgents); });
  es.addEventListener('reporting', (m) => { state.reporting = JSON.parse(m.data); renderReporting(); });
  es.addEventListener('events', (m) => {
    const { key, events } = JSON.parse(m.data);
    addEvents(key, events);
    if (key === state.selected) renderFeed();
    pulse(key);
    canvasActivity(key);
  });
  es.addEventListener('others', (m) => { state.others = JSON.parse(m.data); renderOthers(); renderCounters(); renderCanvas(); updateTimers(); });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

/* ---------------- wiring ---------------- */

$('#legend').innerHTML = CATS.filter((c) => c !== 'other').map((c) => `<span><i style="background:${CAT_COLOR[c]}"></i>${CAT_NAMES[c]}</span>`).join('')
  + '<span><i style="background:var(--text);width:2px"></i>Your message</span>';

for (const b of document.querySelectorAll('#range button')) {
  b.classList.toggle('on', Number(b.dataset.min) === state.rangeMin);
  b.onclick = () => {
    state.rangeMin = Number(b.dataset.min);
    store.set('range', state.rangeMin);
    for (const x of document.querySelectorAll('#range button')) x.classList.toggle('on', x === b);
    renderAxis();
    renderLanes();
  };
}

document.addEventListener('click', (ev) => {
  const machine = ev.target.closest('[data-machine]');
  if (machine) return pickMachine(state.machine === machine.dataset.machine ? '' : machine.dataset.machine);
  const sel = ev.target.closest('[data-select]');
  if (sel) return select(sel.dataset.select);
  const card = ev.target.closest('.card, .lane');
  if (card) return select(card.dataset.key);
  const tool = ev.target.closest('.ev-tool');
  const body = ev.target.closest('.ev-say .body');
  const id = tool?.dataset.id || body?.dataset.id;
  if (id) {
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderFeed();
  }
});

document.addEventListener('submit', (ev) => {
  if (!ev.target.matches('.compose-form')) return;
  ev.preventDefault();
  sendMessage(ev.target);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || !ev.target.matches('.compose-form textarea')) return;
  ev.preventDefault();
  sendMessage(ev.target.form);
});

$('#machine-pick').addEventListener('change', (ev) => pickMachine(ev.target.value));
$('#lanes').addEventListener('mousemove', laneTip);
$('#lanes').addEventListener('mouseleave', () => { $('#tip').hidden = true; });

$('#notify').onclick = async () => {
  if (!('Notification' in window)) return;
  if (!state.notify && Notification.permission !== 'granted') await Notification.requestPermission();
  state.notify = !state.notify && Notification.permission === 'granted';
  store.set('notify', state.notify ? '1' : '0');
  renderNotifyBtn();
};

$('#show-ended').classList.toggle('on', state.showEnded);
$('#show-ended').onclick = () => {
  state.showEnded = !state.showEnded;
  store.set('ended', state.showEnded ? '1' : '0');
  $('#show-ended').classList.toggle('on', state.showEnded);
  renderLanes();
};

renderNotifyBtn();
renderAxis();
setInterval(() => updateTimers(), 1000);
setInterval(() => requestAnimationFrame(drawLanes), 200);
window.addEventListener('resize', renderAxis);
connect();
