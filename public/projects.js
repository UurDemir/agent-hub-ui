'use strict';
// Projects view: which projects use Claude, and how Claude is set up in each.
// Shares helpers ($, esc, fmtDur, fmtK, fmtTime, shortModel, state, select) with app.js.

const PJ = { list: null, detail: new Map(), filter: '' };

const TABS = [
  ['overview', 'Overview'],
  ['instructions', 'CLAUDE.md'],
  ['agents', 'Agents'],
  ['skills', 'Skills'],
  ['commands', 'Commands'],
  ['rules', 'Rules'],
  ['mcp', 'MCP servers'],
  ['hooks', 'Hooks'],
  ['permissions', 'Permissions'],
  ['memory', 'Memory'],
  ['sessions', 'Sessions'],
  ['plugins', 'Plugins'],
];
const BADGES = [
  ['agents', 'agents'], ['skills', 'skills'], ['commands', 'commands'], ['instructions', 'CLAUDE.md'],
  ['rules', 'rules'], ['mcp', 'MCP'], ['hooks', 'hooks'], ['memory', 'memories'], ['plugins', 'plugins'],
];

const ago = (t) => (t ? `${fmtDur(Date.now() - t).split(' ')[0]} ago` : '—');
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/* ---------- tiny markdown renderer (input is escaped first) ---------- */

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code">${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${Math.min(6, h[1].length + 2)} class="md-h">${inlineMd(h[2])}</h${Math.min(6, h[1].length + 2)}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|?\s*$/.test(r));
      out.push(`<table class="md-table">${body.map((r, n) => `<tr>${cells(r).map((c) => (n === 0 ? `<th>${inlineMd(c)}</th>` : `<td>${inlineMd(c)}</td>`)).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const depth = Math.min(3, Math.floor(/^\s*/.exec(lines[i])[0].length / 2));
        items.push(`<li style="margin-left:${depth * 16}px">${inlineMd(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'} class="md-list">${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inlineMd(q.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*([-*+]|\d+[.)])\s+|\s*>|\s*\|)/.test(lines[i])) p.push(lines[i++]);
    if (!p.length) p.push(lines[i++]);
    out.push(`<p>${inlineMd(p.join(' '))}</p>`);
  }
  return out.join('');
}

/* ---------- data ---------- */

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

/* ---------- list ---------- */

function badgesHTML(counts) {
  if (!counts) return '<span class="pj-none">Folder not found</span>';
  const b = BADGES.filter(([k]) => counts[k]).map(([k, label]) => `<span class="pj-badge b-${k}"><b>${counts[k]}</b> ${label}</span>`);
  return b.length ? b.join('') : '<span class="pj-none">No project-level Claude setup</span>';
}

function projectCardHTML(p) {
  const working = p.live.filter((a) => a.status === 'working').length;
  return `
    <a class="pj-card ${p.live.length ? 'is-live' : ''}" href="#/projects/${encodeURIComponent(p.id)}" data-filter="${esc((p.name + ' ' + p.path).toLowerCase())}">
      <div class="pj-card-top">
        <span class="pj-name">${esc(p.name)}</span>
        ${p.live.length ? `<span class="live-badge ${working ? 's-working' : 's-idle'}"><span class="dot"></span>${p.live.length} running</span>` : ''}
      </div>
      <div class="pj-path" title="${esc(p.path)}">${esc(p.path)}</div>
      <div class="pj-badges">${badgesHTML(p.counts)}</div>
      <div class="pj-foot">${p.sessions} session${p.sessions === 1 ? '' : 's'} · active ${ago(p.lastActive)}</div>
    </a>`;
}

function renderProjectList() {
  const host = $('#view-projects');
  const d = PJ.list;
  if (!d) { host.innerHTML = '<div class="pj-loading">Loading projects…</div>'; return; }
  host.innerHTML = `
    <div class="pj-top">
      <div>
        <h2 class="pj-h1">Projects</h2>
        <p class="pj-sub">Every folder you've used Claude Code in, and how Claude is set up there.</p>
      </div>
      <input class="search" id="pj-filter" placeholder="Filter projects…" value="${esc(PJ.filter)}">
    </div>
    <div class="pj-grid">
      <a class="pj-card user" href="#/projects/user" data-filter="global user">
        <div class="pj-card-top"><span class="pj-name">Your global setup</span><span class="tag">applies to every project</span></div>
        <div class="pj-path">${esc(d.user.path)}</div>
        <div class="pj-badges">${badgesHTML(d.user.counts)}</div>
        <div class="pj-foot">User-level agents, skills, hooks, MCP servers and plugins</div>
      </a>
      ${d.projects.map(projectCardHTML).join('')}
    </div>`;
  const input = $('#pj-filter');
  const apply = () => {
    PJ.filter = input.value;
    const q = input.value.trim().toLowerCase();
    for (const c of host.querySelectorAll('.pj-card')) c.hidden = !!q && !c.dataset.filter.includes(q);
  };
  input.oninput = apply;
  apply();
}

async function showProjectList() {
  renderProjectList();
  try { PJ.list = await getJson('/api/projects'); } catch (e) { $('#view-projects').innerHTML = `<div class="pj-loading">Couldn't load projects: ${esc(e.message)}</div>`; return; }
  if (currentRoute().view === 'projects' && !currentRoute().id) renderProjectList();
}

/* ---------- detail sections ---------- */

const usedCount = (map, name) => {
  if (!map) return 0;
  let n = map[name] || 0;
  for (const [k, v] of Object.entries(map)) if (k !== name && k.endsWith(':' + name)) n += v;
  return n;
};

function itemHTML(it, { chips = [], open = false } = {}) {
  return `
    <details class="item" ${open ? 'open' : ''} data-filter="${esc((it.name + ' ' + (it.description || '')).toLowerCase())}">
      <summary>
        <div class="item-h">
          <span class="item-name">${esc(it.name)}</span>
          ${chips.filter(Boolean).join('')}
        </div>
        ${it.description ? `<div class="item-desc">${esc(it.description)}</div>` : ''}
      </summary>
      <div class="item-body">
        <div class="item-path">${esc(it.file || it.rel || '')}</div>
        ${it.files?.length ? `<div class="item-files">Also in this skill: ${it.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
        <div class="md">${md(it.body) || '<p class="pj-none">Empty file.</p>'}</div>
      </div>
    </details>`;
}

const chip = (text, cls = '') => `<span class="ichip ${cls}">${esc(text)}</span>`;

function listSection(items, opts, emptyText) {
  if (!items.length) return `<div class="pj-empty">${emptyText}</div>`;
  return `
    ${items.length > 6 ? '<input class="search item-filter" placeholder="Filter…">' : ''}
    <div class="items">${items.map((it) => itemHTML(it, opts(it))).join('')}</div>`;
}

function sectionHTML(d, tab) {
  const c = d.config;
  if (!c) return '<div class="pj-empty">This folder no longer exists on disk, so its Claude setup can\'t be read. Its sessions are still listed.</div>';
  const u = d.usage;
  switch (tab) {
    case 'instructions':
      return listSection(c.instructions, () => ({ open: c.instructions.length <= 2, chips: [] }),
        'No CLAUDE.md here. Claude reads <code>CLAUDE.md</code> (and <code>CLAUDE.local.md</code>) at the start of every session; <code>/init</code> creates one.');
    case 'agents':
      return listSection(c.agents, (a) => ({
        chips: [
          a.source === 'user' ? chip('global', 'dim') : '',
          a.model && chip(a.model === 'inherit' ? 'model: inherit' : shortModel(a.model)),
          a.tools.length ? chip(`${a.tools.length} tools`) : chip('all tools', 'dim'),
          usedCount(u?.agents, a.name) ? chip(`used ${usedCount(u.agents, a.name)}×`, 'used') : '',
        ],
      }), 'No subagents defined. Add them as Markdown files in <code>.claude/agents/</code>.');
    case 'skills':
      return listSection(c.skills, (s) => ({
        chips: [
          s.source === 'claude.ai' ? chip('synced from claude.ai', 'dim') : '',
          s.files?.length ? chip(`${s.files.length + 1} files`) : '',
          usedCount(u?.skills, s.name) ? chip(`used ${usedCount(u.skills, s.name)}×`, 'used') : '',
        ],
      }), 'No skills here. Skills live in <code>.claude/skills/&lt;name&gt;/SKILL.md</code>.');
    case 'commands':
      return listSection(c.commands, (cmd) => ({
        chips: [
          cmd.argumentHint && chip(cmd.argumentHint, 'dim'),
          usedCount(u?.commands, cmd.name) ? chip(`used ${usedCount(u.commands, cmd.name)}×`, 'used') : '',
        ],
      }), 'No custom slash commands. Add them as Markdown files in <code>.claude/commands/</code>.');
    case 'rules':
      return listSection(c.rules, (r) => ({ chips: r.paths.length ? [chip(`applies to ${r.paths.join(', ')}`, 'dim')] : [chip('always', 'dim')] }),
        'No rule files. Rules are Markdown files in <code>.claude/rules/</code>, optionally scoped to paths.');
    case 'memory':
      return listSection(c.memory, (m) => ({ chips: [m.type && chip(m.type, `mem-${m.type}`)], open: m.type === 'index' }),
        'No auto-memory saved for this project yet.');
    case 'mcp':
      if (!c.mcp.length) return '<div class="pj-empty">No MCP servers configured at this level.</div>';
      return `<table class="tbl">
        <tr><th>Server</th><th>Scope</th><th>Type</th><th>Runs</th><th>Env / headers</th></tr>
        ${c.mcp.map((s) => `<tr>
          <td><b>${esc(s.name)}</b>${s.state ? ` ${chip(s.state, s.state === 'disabled' ? 'off' : 'used')}` : ''}</td>
          <td>${chip(s.scope)}<div class="dimtxt">${esc(s.source)}</div></td>
          <td>${esc(s.type)}</td>
          <td><code class="wrap">${esc(s.target)}</code></td>
          <td>${[...s.env, ...s.headers].map((k) => `<code>${esc(k)}</code>`).join(' ') || '<span class="dimtxt">—</span>'}</td>
        </tr>`).join('')}
      </table><p class="pj-note">Values of environment variables, headers and anything that looks like a credential are hidden.</p>`;
    case 'hooks':
      if (!c.hooks.length) return '<div class="pj-empty">No hooks configured at this level.</div>';
      return `<table class="tbl">
        <tr><th>Event</th><th>Matcher</th><th>Runs</th><th>Defined in</th></tr>
        ${c.hooks.map((h) => `<tr><td>${chip(h.event, 'used')}</td><td><code>${esc(h.matcher)}</code></td>
          <td><code class="wrap">${esc(h.command)}</code>${h.timeout ? `<div class="dimtxt">timeout ${h.timeout}s</div>` : ''}</td>
          <td class="dimtxt">${esc(h.source)}</td></tr>`).join('')}
      </table>`;
    case 'permissions': {
      const blocks = c.settings.map((s) => {
        const p = s.permissions;
        const list = (label, arr, cls) => (arr.length ? `<div class="perm"><span class="perm-l">${label}</span><div class="perm-v">${arr.map((x) => chip(x, cls)).join('')}</div></div>` : '');
        const body = [
          list('Allow', p.allow, 'used'), list('Ask', p.ask, ''), list('Deny', p.deny, 'off'),
          list('Extra folders', p.additionalDirectories, 'dim'),
          p.defaultMode ? list('Default mode', [p.defaultMode], '') : '',
          s.model ? list('Model', [s.model], '') : '',
          list('Env vars', s.env, 'dim'),
          s.other.length ? list('Other settings', s.other, 'dim') : '',
        ].join('');
        return `<div class="perm-card"><h4>${esc(s.label)}</h4>${body || '<div class="dimtxt">Nothing set.</div>'}</div>`;
      });
      if (c.allowedTools?.length) blocks.push(`<div class="perm-card"><h4>~/.claude.json (approved in prompts)</h4><div class="perm-v">${c.allowedTools.map((x) => chip(x, 'used')).join('')}</div></div>`);
      return blocks.length ? blocks.join('') : '<div class="pj-empty">No settings files at this level.</div>';
    }
    case 'sessions':
      if (!d.sessions.length) return '<div class="pj-empty">No sessions recorded.</div>';
      return `<table class="tbl">
        <tr><th>Session</th><th>Branch</th><th>Last active</th><th>Size</th></tr>
        ${d.sessions.map((s) => {
          const live = d.live.find((a) => a.key === s.id);
          return `<tr>
            <td><div class="sess-title">${live ? `<a href="#/live/${encodeURIComponent(s.id)}" class="live-badge s-${live.status}"><span class="dot"></span>live</a> ` : ''}${esc(s.title || s.lastPrompt || '(untitled)')}</div>
              ${s.title && s.lastPrompt ? `<div class="dimtxt">› ${esc(s.lastPrompt)}</div>` : ''}<div class="dimtxt mono">${esc(s.id)}</div></td>
            <td class="mono">${esc(s.branch || '—')}</td>
            <td>${fmtTime(s.mtime)}<div class="dimtxt">${ago(s.mtime)}</div></td>
            <td class="mono">${fmtSize(s.size)}</td></tr>`;
        }).join('')}
      </table>`;
    case 'plugins':
      if (!c.plugins?.length) return '<div class="pj-empty">No plugins installed.</div>';
      return `<div class="plug-grid">${c.plugins.map((p) => {
        const parts = [
          p.skills.length && `${p.skills.length} skills`, p.agents.length && `${p.agents.length} agents`,
          p.commands.length && `${p.commands.length} commands`, p.hooks.length && `hooks: ${p.hooks.join(', ')}`,
          p.mcp.length && `MCP: ${p.mcp.join(', ')}`,
        ].filter(Boolean);
        const names = [...p.agents.map((x) => `agent ${x}`), ...p.commands, ...p.skills.slice(0, 40)];
        return `<details class="plug ${p.enabled ? '' : 'off'}">
          <summary><div class="item-h"><span class="item-name">${esc(p.name)}</span>${chip(p.enabled ? 'enabled' : 'disabled', p.enabled ? 'used' : 'off')}${p.version ? chip('v' + p.version, 'dim') : ''}</div>
          <div class="item-desc">${esc(parts.join(' · ') || 'LSP / settings only')}</div><div class="dimtxt">${esc(p.marketplace)}</div></summary>
          ${names.length ? `<div class="item-body">${names.map((n) => `<code>${esc(n)}</code>`).join(' ')}${p.skills.length > 40 ? ` <span class="dimtxt">+${p.skills.length - 40} more</span>` : ''}</div>` : ''}
        </details>`;
      }).join('')}</div>`;
    default:
      return overviewHTML(d);
  }
}

function topUsage(map, n = 6) {
  return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function overviewHTML(d) {
  const c = d.counts || {};
  const tiles = TABS.filter(([k]) => k !== 'overview' && k !== 'permissions' && (k !== 'plugins' || d.isUser) && (k !== 'sessions' || !d.isUser))
    .map(([k, label]) => {
      const n = k === 'sessions' ? d.sessions.length : c[k] ?? 0;
      return `<a class="tile ${n ? '' : 'zero'}" href="#/projects/${encodeURIComponent(d.id)}/${k}"><b>${n}</b><span>${label}</span></a>`;
    }).join('');

  let html = `<div class="tiles">${tiles}</div>`;

  if (d.inherited) {
    const inh = Object.entries(d.inherited).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
    if (inh.length) html += `<div class="pj-note">Also loaded here from <a href="#/projects/user">your global setup</a>: ${esc(inh.join(' · '))}.</div>`;
  }

  if (d.live.length) {
    html += `<h4 class="pj-h4">Running now</h4><div class="live-list">${d.live.map((a) => `
      <a class="live-row s-${a.status}" href="#/live/${encodeURIComponent(a.key)}">
        <span class="dot"></span><b>${esc(a.name)}</b>
        <span class="dimtxt">${esc(a.now?.verb || '')} ${esc(a.now?.summary || '')}</span></a>`).join('')}</div>`;
  }

  if (d.usage) {
    const cols = [['Agents used', d.usage.agents], ['Skills used', d.usage.skills], ['Slash commands', d.usage.commands]]
      .filter(([, m]) => Object.keys(m).length)
      .map(([title, m]) => `<div class="use-col"><h4 class="pj-h4">${title}</h4>${topUsage(m).map(([k, v]) => `<div class="use-row"><span>${esc(k)}</span><b>${v}×</b></div>`).join('')}</div>`);
    if (cols.length) html += `<div class="use-grid">${cols.join('')}</div>`;
  }

  if (d.sessions.length) {
    html += `<h4 class="pj-h4">Recent sessions</h4><div class="live-list">${d.sessions.slice(0, 5).map((s) => `
      <div class="live-row"><b>${esc(s.title || s.lastPrompt || '(untitled)')}</b><span class="dimtxt">${esc(s.branch || '')} · ${ago(s.mtime)}</span></div>`).join('')}</div>`;
  }

  if (d.stats && (d.stats.lastCost || d.stats.linesAdded || d.stats.outputTokens)) {
    const s = d.stats;
    html += `<h4 class="pj-h4">Last finished session</h4><div class="kv" style="max-width:520px">
      ${s.lastCost ? `<dt>Cost</dt><dd>$${s.lastCost.toFixed(2)}</dd>` : ''}
      ${s.lastDuration ? `<dt>Duration</dt><dd>${fmtDur(s.lastDuration)}</dd>` : ''}
      ${s.linesAdded || s.linesRemoved ? `<dt>Lines</dt><dd>+${s.linesAdded || 0} / −${s.linesRemoved || 0}</dd>` : ''}
      ${s.outputTokens ? `<dt>Tokens</dt><dd>${fmtK(s.inputTokens)} in · ${fmtK(s.outputTokens)} out</dd>` : ''}
      ${s.models?.length ? `<dt>Models</dt><dd>${esc(s.models.map(shortModel).join(', '))}</dd>` : ''}
    </div>`;
  }
  return html;
}

function renderProject(d, tab) {
  const host = $('#view-projects');
  const c = d.counts || {};
  const tabs = TABS.filter(([k]) => (k !== 'plugins' || d.isUser) && (k !== 'sessions' && k !== 'memory' || !d.isUser));
  const countOf = (k) => (k === 'sessions' ? d.sessions.length : k === 'overview' || k === 'permissions' ? null : c[k]);
  host.innerHTML = `
    <a class="back" href="#/projects">← All projects</a>
    <header class="pj-hero">
      <div>
        <h2 class="pj-title">${esc(d.name)}</h2>
        <div class="pj-path">${esc(d.path)}</div>
      </div>
      <div class="chips">${d.live.map((a) => `<a class="live-badge s-${a.status}" href="#/live/${encodeURIComponent(a.key)}"><span class="dot"></span>${esc(a.name)}</a>`).join('')}</div>
    </header>
    <nav class="pj-tabs">${tabs.map(([k, label]) => {
      const n = countOf(k);
      return `<a href="#/projects/${encodeURIComponent(d.id)}/${k}" class="${k === tab ? 'on' : ''} ${n === 0 ? 'zero' : ''}">${label}${n != null ? `<span>${n}</span>` : ''}</a>`;
    }).join('')}</nav>
    <section class="pj-body">${sectionHTML(d, tab)}</section>`;

  const on = host.querySelector('.pj-tabs a.on');
  if (on) on.parentElement.scrollLeft = on.offsetLeft - on.parentElement.clientWidth / 2 + on.clientWidth / 2;

  const filter = host.querySelector('.item-filter');
  if (filter) {
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const el of host.querySelectorAll('.items > .item')) el.hidden = !!q && !el.dataset.filter.includes(q);
    };
  }
}

async function showProject(id, tab) {
  const cached = PJ.detail.get(id);
  if (cached) renderProject(cached.data, tab);
  else $('#view-projects').innerHTML = '<div class="pj-loading">Reading project setup…</div>';
  if (cached && Date.now() - cached.at < 10000) return;
  try {
    const data = await getJson(`/api/projects/${encodeURIComponent(id)}`);
    PJ.detail.set(id, { data, at: Date.now() });
    const r = currentRoute();
    if (r.view === 'projects' && r.id === id) renderProject(data, r.tab);
  } catch (e) {
    $('#view-projects').innerHTML = `<a class="back" href="#/projects">← All projects</a><div class="pj-loading">Couldn't load this project: ${esc(e.message)}</div>`;
  }
}

/* ---------- routing ---------- */

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'projects') return { view: 'projects', id: parts[1] || null, tab: parts[2] || 'overview' };
  return { view: 'live', key: parts[0] === 'live' ? parts.slice(1).join('/') : null };
}

function route() {
  const r = currentRoute();
  $('#view-live').hidden = r.view !== 'live';
  $('#view-projects').hidden = r.view !== 'projects';
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('on', a.dataset.view === r.view);
  if (r.view === 'projects') {
    window.scrollTo(0, 0);
    if (r.id) showProject(r.id, r.tab); else showProjectList();
  } else if (r.key) {
    state.selected = r.key;
    store.set('sel', r.key);
    if (state.byKey.has(r.key)) select(r.key);
  }
}

window.addEventListener('hashchange', route);
route();
