// History (#/history[/<key>]) and Usage (#/usage) pages. Classic script sharing globals with
// app.js (state, esc, fmtTime, fmtK, eventHTML, filesChangedHTML…) and projects.js (getJson, ago);
// it loads before projects.js, whose router calls showHistory() / showUsage().

const HS = { q: '', data: null, key: null, detail: null, loading: false, seq: 0, days: 30, usage: null };

// fmtUsd comes from canvas.js.
const dayLabel = (t) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400e3);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

function snippetHTML(m, q) {
  if (!m) return '';
  const text = String(m.text || '');
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  const body = i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  return `<div class="snip"><b>${m.who === 'prompt' ? 'YOU' : 'CLAUDE'}</b> ${body}</div>`;
}

/* ---------- history ---------- */

async function loadHistory(more = false) {
  const seq = ++HS.seq;
  HS.loading = true;
  renderHistory();
  const before = more && HS.data?.local ? (HS.data.local.stoppedAt || HS.data.local.sessions.at(-1)?.lastAt || '') : '';
  try {
    const d = await getJson(`/api/history?q=${encodeURIComponent(HS.q)}${before ? `&before=${before}` : ''}`);
    if (seq !== HS.seq) return;
    if (more && HS.data?.local && d.local) {
      d.local.sessions = [...HS.data.local.sessions, ...d.local.sessions.filter((s) => !HS.data.local.sessions.some((x) => x.key === s.key))];
    }
    HS.data = d;
  } catch (e) {
    if (seq === HS.seq) HS.data = { error: e.message };
  }
  HS.loading = false;
  if (seq === HS.seq) renderHistory();
}

function historyItems() {
  const d = HS.data || {};
  const items = [];
  for (const s of d.local?.sessions || []) items.push({ key: s.key, t: s.lastAt, name: s.name, project: s.project, branch: s.branch, model: s.model, machine: '', match: s.match, local: true });
  for (const h of d.remote || []) {
    const a = h.agent;
    items.push({ key: h.key, t: h.endedAt, name: a.name, project: a.project, branch: a.branch, model: a.model, machine: h.machine, kind: a.kind, outTokens: a.outTokens, toolCount: a.toolCount });
  }
  return items.sort((a, b) => b.t - a.t);
}

function renderHistory() {
  const host = $('#view-history');
  if (host.hidden) return;
  const d = HS.data;
  if (!host.querySelector('#hs-q')) {
    host.innerHTML = `
      <div class="pj-top">
        <div>
          <h2 class="pj-h1">History</h2>
          <p class="pj-sub" id="hs-sub"></p>
        </div>
        <input class="search" id="hs-q" placeholder="Search prompts and replies…" value="${esc(HS.q)}">
      </div>
      <div class="hs-layout"><div><div class="hs-list" id="hs-list"></div></div><aside class="panel detail hs-detail" id="hs-detail"></aside></div>`;
    let timer;
    $('#hs-q').oninput = (ev) => {
      clearTimeout(timer);
      timer = setTimeout(() => { HS.q = ev.target.value.trim(); loadHistory(); }, 350);
    };
  }
  $('#hs-sub').textContent = state.projectsOn
    ? `Past sessions on this PC${state.machines ? ', and the ended sessions machines reported to this hub' : ''}. Search looks through prompts and replies.`
    : 'Ended sessions that machines reported to this hub, with what each machine shared.';
  const list = $('#hs-list');
  if (!d) { list.innerHTML = '<div class="pj-loading">Loading…</div>'; renderHistoryDetail(); return; }
  if (d.error) { list.innerHTML = `<div class="pj-loading">Couldn't load the history: ${esc(d.error)}</div>`; return; }
  const items = historyItems();
  let html = '';
  let group = '';
  for (const it of items) {
    const g = dayLabel(it.t);
    if (g !== group) { group = g; html += `<div class="hs-group">${esc(g)}</div>`; }
    html += `<a class="hs-item ${HS.key === it.key ? 'sel' : ''}" href="#/history/${encodeURIComponent(it.key)}">
      <div class="t" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="m">${it.machine ? `<span>⌂ ${esc(it.machine)}</span>` : ''}<span>${esc(it.project || '—')}</span>${it.branch ? `<span>⎇ ${esc(it.branch)}</span>` : ''}
        ${it.kind && TOOL_KINDS[it.kind] ? `<span>${esc(it.kind)}</span>` : ''}<span>${esc(shortModel(it.model))}</span><span>${fmtTime(it.t)}</span></div>
      ${snippetHTML(it.match, HS.q)}
    </a>`;
  }
  if (!items.length) html = `<div class="pj-empty">${HS.loading ? 'Searching…' : HS.q ? 'Nothing matches that.' : 'No past sessions yet.'}</div>`;
  const local = d.local;
  if (local?.more) {
    html += `<button class="btn hs-more" id="hs-more">${HS.loading ? 'Loading…' : HS.q ? `Search older sessions${local.scanned ? ` (looked through ${local.scanned})` : ''}` : 'Older sessions'}</button>`;
  }
  list.innerHTML = html;
  const more = $('#hs-more');
  if (more) more.onclick = () => loadHistory(true);
  renderHistoryDetail();
}

async function openHistory(key) {
  HS.key = key;
  HS.detail = null;
  renderHistory();
  if (!key) return;
  try {
    const d = await getJson(`/api/history/${encodeURIComponent(key)}`);
    if (HS.key !== key) return;
    // Link results to their tool calls, as the live view does.
    const byTool = new Map();
    const events = {};
    for (const [k, evs] of Object.entries(d.events || {})) {
      events[k] = [];
      for (const e of evs) {
        if (e.kind === 'result') { const t = byTool.get(e.toolId); if (t) t.result = e; continue; }
        const x = { ...e };
        if (x.kind === 'tool') byTool.set(x.toolId, x);
        events[k].push(x);
      }
    }
    HS.detail = { agent: d.agent, events };
  } catch (e) {
    if (HS.key === key) HS.detail = { error: e.message };
  }
  renderHistoryDetail();
}

function renderHistoryDetail() {
  const host = $('#hs-detail');
  if (!host) return;
  const x = HS.detail;
  if (!HS.key) { host.innerHTML = '<div class="empty">Pick a session to see what happened in it.</div>'; return; }
  if (!x) { host.innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (x.error) { host.innerHTML = `<div class="empty">${esc(x.error)}</div>`; return; }
  const a = x.agent;
  const evs = Object.values(x.events).flat().sort((p, q) => p.t - q.t);
  const kv = (k, v) => (v ? `<dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd>` : '');
  host.innerHTML = `
    <div class="d-head s-offline">
      <div class="card-top"><span class="status">ENDED</span>${kindTag(a)}${a.machine ? `<span class="tag">⌂ ${esc(a.machine)}</span>` : ''}</div>
      <h3>${esc(a.name)}</h3>
      ${a.title && a.title !== a.name ? `<div class="d-title">${esc(a.title)}</div>` : ''}
      <dl class="kv">
        ${kv('Folder', a.cwd || a.project)}${kv('Branch', a.branch)}${kv('Model', a.model)}
        ${kv('Output', a.outTokens ? `${fmtK(a.outTokens)} tokens · ${a.toolCount || 0} tool calls` : '')}
        ${kv('Cost', typeof a.cost === 'number' ? `≈ ${fmtUsd(a.cost)}` : '')}
        ${kv('Started', a.startedAt ? new Date(a.startedAt).toLocaleString() : '')}
        ${kv('Last activity', a.lastAt ? new Date(a.lastAt).toLocaleString() : '')}
        ${kv('Session', a.sessionId || '')}
      </dl>
      ${a.truncated ? '<div class="share-note">This is a long session: only its last 8 MB are shown.</div>' : ''}
      ${a.remote && SHARE_NOTE[a.share] ? `<div class="share-note">${esc(SHARE_NOTE[a.share])}</div>` : ''}
    </div>
    ${a.todos?.length ? `<div class="d-section"><h4>Plan</h4><ul class="todos">${a.todos.map((t) => `<li class="${esc(t.status)}">${esc(t.content)}</li>`).join('')}</ul></div>` : ''}
    ${filesChangedHTML(`history:${HS.key}`, evs)}
    <div class="feed-h"><h4 style="margin:0;font:600 11px var(--mono);letter-spacing:.1em;color:var(--dim)">TIMELINE · NEWEST FIRST</h4><span class="ev-time">${evs.length} events</span></div>
    <div class="feed">${evs.length ? evs.slice().reverse().map((e) => eventHTML(e, a)).join('') : '<div class="ev ev-note">No activity was recorded.</div>'}</div>`;
}

function showHistory(key) {
  if (!HS.data && !HS.loading) loadHistory();
  if (key !== HS.key) openHistory(key); else renderHistory();
}

// Expanding a tool call or a reply in the history timeline (app.js toggles state.expanded first).
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#hs-detail')) return;
  if (ev.target.closest('.ev-tool, .ev-say .body')) renderHistoryDetail();
});

/* ---------- usage ---------- */

async function loadUsage() {
  HS.usage = { loading: true };
  renderUsage();
  try {
    HS.usage = await getJson(`/api/usage?days=${HS.days}`);
  } catch (e) {
    HS.usage = { error: e.message };
  }
  renderUsage();
}

function usageTable(rows, first, firstLabel) {
  if (!rows.length) return '<div class="pj-empty">Nothing in this period.</div>';
  return `<table class="us-table"><thead><tr><th>${firstLabel}</th><th>Sessions</th><th>Output</th><th>Input</th><th>Cache read</th><th>Cost</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r[first])}</td><td>${r.sessions}</td><td>${fmtK(r.out)}</td><td>${fmtK(r.in + r.cacheWrite)}</td><td>${fmtK(r.cacheRead)}</td><td>${r.priced ? fmtUsd(r.cost) : '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderUsage() {
  const host = $('#view-usage');
  if (host.hidden) return;
  const u = HS.usage;
  const head = `
    <div class="pj-top">
      <div>
        <h2 class="pj-h1">Usage</h2>
        <p class="pj-sub">${state.projectsOn ? 'Tokens and estimated cost of the Claude Code sessions on this PC' : 'Tokens and cost the machines reported to this hub'}${state.machines && state.projectsOn ? ', and what each machine reported to this hub' : ''}. Costs are estimates priced with the rates Claude Code records.</p>
      </div>
      <div class="seg" id="us-days">${[7, 30, 90].map((d) => `<button data-days="${d}" class="${HS.days === d ? 'on' : ''}">${d}d</button>`).join('')}</div>
    </div>`;
  if (!u || u.loading) { host.innerHTML = `${head}<div class="pj-loading">Adding up your transcripts… (the first time can take a few seconds)</div>`; bindUsage(); return; }
  if (u.error) { host.innerHTML = `${head}<div class="pj-loading">Couldn't load usage: ${esc(u.error)}</div>`; bindUsage(); return; }
  let html = head;
  const l = u.local;
  if (l) {
    const tot = l.byDay.reduce((t, d) => ({ out: t.out + d.out, in: t.in + d.in + d.cacheWrite, cache: t.cache + d.cacheRead, cost: t.cost + d.cost }), { out: 0, in: 0, cache: 0, cost: 0 });
    const sessions = l.byProject.reduce((n, p) => n + p.sessions, 0);
    html += `<div class="us-cards">
      <div class="us-card"><b>${fmtK(tot.out)}</b><span>output tokens</span></div>
      <div class="us-card"><b>${fmtK(tot.in)}</b><span>input tokens</span></div>
      <div class="us-card"><b>${fmtK(tot.cache)}</b><span>cache reads</span></div>
      <div class="us-card"><b>${l.priced ? fmtUsd(tot.cost) : '—'}</b><span>estimated cost</span></div>
      <div class="us-card"><b>${sessions}</b><span>sessions</span></div>
    </div>`;
    // One bar per day, every day of the period (empty days too).
    const byDay = new Map(l.byDay.map((d) => [d.day, d]));
    const days = [];
    for (let i = l.days - 1; i >= 0; i--) {
      const t = new Date(Date.now() - i * 86400e3);
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      days.push({ key, t, d: byDay.get(key) });
    }
    const metric = l.priced ? (d) => d?.cost || 0 : (d) => d?.out || 0;
    const max = Math.max(...days.map((x) => metric(x.d)), 1e-9);
    html += `<div><div class="us-chart">${days.map((x) => `<div class="us-bar" style="height:${Math.max(1, (metric(x.d) / max) * 100).toFixed(1)}%" title="${esc(x.t.toLocaleDateString())}: ${x.d ? `${fmtK(x.d.out)} output tokens${l.priced ? ` · ${fmtUsd(x.d.cost)}` : ''}` : 'no sessions'}"></div>`).join('')}</div>
      <div class="us-axis"><span>${esc(days[0].t.toLocaleDateString())}</span><span>${l.priced ? 'estimated cost per day' : 'output tokens per day'}</span><span>today</span></div></div>`;
    html += `<div class="us-grid">
      <section class="panel"><div class="panel-h"><h2>By project</h2></div>${usageTable(l.byProject.slice(0, 25), 'project', 'Project')}</section>
      <section class="panel"><div class="panel-h"><h2>By model</h2></div>${usageTable(l.byModel, 'model', 'Model')}</section>
    </div>`;
  }
  if (u.machines) {
    html += `<section class="panel"><div class="panel-h"><h2>By machine</h2><span class="sub">sessions this hub saw, with the tokens and cost each machine reported</span></div>
      ${u.machines.length ? `<table class="us-table"><thead><tr><th>Machine</th><th>Sessions</th><th>Output</th><th>Cost</th></tr></thead><tbody>
        ${u.machines.map((m) => `<tr><td>${esc(m.machine)}</td><td>${m.sessions}</td><td>${fmtK(m.out)}</td><td>${m.priced ? fmtUsd(m.cost) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="pj-empty">No machine has reported a session in this period.</div>'}
    </section>`;
  }
  if (!l && !u.machines) html += '<div class="pj-empty">Usage is only available on the PC itself, or on a hub.</div>';
  host.innerHTML = html;
  bindUsage();
}

function bindUsage() {
  for (const b of document.querySelectorAll('#us-days button')) {
    b.onclick = () => { HS.days = Number(b.dataset.days); loadUsage(); };
  }
}

function showUsage() {
  // Reloaded on each visit: the numbers grow while sessions run (the server caches per file).
  if (!HS.usage?.loading) loadUsage(); else renderUsage();
}
