'use strict';
// Canvas view: a live node graph of the agents on this PC.
// Agents are glowing hexagons (subagents hang off their parent on curved edges), recent tool
// calls float around them as boxes, and Claude's latest message shows as a speech bubble.
// A timeline at the bottom shows every event and can scrub back or replay what happened.
// #/canvas shows every project, #/canvas/<project id> just one.
// Drawn with a <canvas> (stars, edges, hexagons, rings) under an HTML layer (labels, boxes,
// bubbles) that shares the same camera. Uses globals from app.js ($, esc, state, store, CATS,
// CAT_COLOR, COLOR, fmt*, shortModel, nowText, updateTimers…).

const FL = {
  project: null,
  ended: store.get('cv.ended', '0') === '1',
  panel: store.get('cv.panel', 'cost'),        // '', 'cost', 'chat' or 'files'
  timeline: store.get('cv.timeline', '1') === '1',
  selected: null,                              // agent key in focus
  cam: { x: 0, y: 0, z: 0.8 },
  target: null,                                // camera position being eased towards
  follow: true,                                // keep everything in view until the user pans
  review: null,                                // null = live, else { t, playing, speed }
  model: null,                                 // nodes, boxes and bubbles from the last rebuild
  dirty: true,
  raf: 0,
  builtAt: 0,
  open: new Set(),                             // tool boxes expanded to show input/output
  overlay: new Map(),                          // overlay key -> element
  drag: null,
  stars: Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() * 1.3 + 0.3, p: Math.random() * 6.3 })),
};

const ROLE = { main: '#5aa7ff', sub: '#ffb547' };
const BOX_LINGER_MS = 40e3;   // how long a finished tool call stays on the canvas
const AGENT_LINGER_MS = 90e3; // how long an ended session or finished subagent stays…
const AGENT_FADE_MS = 30e3;   // …fading out over the last part of that time
const BUBBLE_MS = 90e3;       // how long Claude's last message stays as a bubble
const MAX_SPAN_MS = 3 * 3600e3;
const MAIN_SLOTS = [180, 222, 138]; // where a main agent's tool calls sit, in degrees (y points down)
const SUBS_PER_ROW = 6;
const SUB_GAP_X = 360;
const SUB_GAP_Y = 560;
const SUB_TOP = 400;

/* ---------- grouping ---------- */

// Same folder naming Claude Code uses under ~/.claude/projects, so ids match the Projects page.
const projectIdOf = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
// Agents working in a Claude Code worktree (<repo>/.claude/worktrees/<name>) belong to <repo>.
const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees[\\/].*$/;
const projectRootOf = (cwd) => String(cwd || '').replace(WORKTREE_RE, '');
const inWorktree = (a) => WORKTREE_RE.test(a.cwd || '');
const startOf = (a) => a.startedAt || (state.events.get(a.key) || [])[0]?.t || a.lastAt || 0;

// Projects and their agents in a stable order (oldest first), so the map doesn't jump around.
function flGroups(includeEnded) {
  const groups = new Map();
  for (const a of state.agents) {
    if (!a.live && !includeEnded) continue;
    const root = projectRootOf(a.cwd);
    const id = projectIdOf(root) || 'unknown';
    const name = root.split(/[\\/]/).filter(Boolean).pop() || a.project || 'Unknown folder';
    const g = groups.get(id) || { id, name, cwd: root, agents: [] };
    g.agents.push(a);
    groups.set(id, g);
  }
  for (const g of groups.values()) g.agents.sort((x, y) => startOf(x) - startOf(y));
  return [...groups.values()].sort((x, y) => startOf(x.agents[0]) - startOf(y.agents[0]));
}

/* ---------- time: live or review ---------- */

const nowT = () => (FL.review ? FL.review.t : Date.now());
const resultAt = (e) => e.result?.t || (e.result ? e.t + (e.result.ms || 0) : Infinity);
const eventsAt = (key, T) => {
  const evs = state.events.get(key) || [];
  return FL.review ? evs.filter((e) => e.t <= T) : evs;
};

// While reviewing, an agent counts as working if a tool was in flight or it acted in the last 20s.
function statusAt(a, T) {
  if (!FL.review) return a.status;
  const evs = eventsAt(a.key, T);
  if (!evs.length) return 'idle';
  const pending = evs.some((e) => e.kind === 'tool' && resultAt(e) > T);
  return pending || T - evs[evs.length - 1].t < 20e3 ? 'working' : 'idle';
}
const visibleAt = (a, T) => !FL.review || startOf(a) <= T;

function lastActivity(a, T) {
  if (!FL.review) return a.lastAt || 0;
  const evs = eventsAt(a.key, T);
  return evs.length ? evs[evs.length - 1].t : startOf(a);
}

// Ended sessions and finished subagents linger after their last activity, then fade out like
// finished tool calls (1 = fully shown, 0 = gone). The Ended toggle keeps them on the map.
function agentFade(a, isSub, status, T) {
  if (FL.ended) return 1;
  const finished = isSub ? status !== 'working' : status === 'offline';
  if (!finished) return 1;
  return Math.max(0, Math.min(1, (AGENT_LINGER_MS - (T - lastActivity(a, T))) / AGENT_FADE_MS));
}

/* ---------- layout ---------- */

function recentTools(key, T, status) {
  const evs = eventsAt(key, T).filter((e) => e.kind === 'tool').slice(-30);
  const out = [];
  for (let i = evs.length - 1; i >= 0 && out.length < 3; i--) {
    const e = evs[i];
    const done = resultAt(e) <= T;
    const age = done ? T - resultAt(e) : 0;
    if (FL.open.has(e.id) || (!done && (status === 'working' || FL.review)) || (done && age < BOX_LINGER_MS)) out.push({ e, done, age });
  }
  return out.reverse();
}

function lastMessage(key, T) {
  const evs = eventsAt(key, T);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === 'say' || e.kind === 'prompt') return T - e.t < BUBBLE_MS ? e : null;
    if (e.kind === 'tool' && T - e.t > BUBBLE_MS) return null;
  }
  return null;
}

function buildModel() {
  const T = nowT();
  const groups = flGroups(true).filter((g) => !FL.project || g.id === FL.project);
  const nodes = [];
  const rows = [];
  let y = 0;
  for (const g of groups) {
    const agents = g.agents
      .filter((a) => visibleAt(a, T))
      .map((a) => { const status = statusAt(a, T); return { a, status, fade: agentFade(a, false, status, T) }; })
      .filter((x) => x.fade > 0);
    if (!agents.length) continue;
    let x = 0;
    let rowDepth = 0;
    rows.push({ g, x: -260, y: y - 230, fade: Math.max(...agents.map((m) => m.fade)) });
    for (const { a, status, fade } of agents) {
      // Subagents fan out below their parent in rows, each with its tool calls stacked underneath.
      const subs = a.subagents
        .filter((s) => visibleAt(s, T))
        .map((s) => { const st = statusAt(s, T); return { s, status: st, fade: Math.min(fade, agentFade(s, true, st, T)) }; })
        .filter((x) => x.fade > 0)
        .sort((p, q) => startOf(p.s) - startOf(q.s));
      const perRow = Math.min(subs.length, SUBS_PER_ROW);
      const cellW = Math.max(1000, perRow * SUB_GAP_X + 360);
      const cx = x + cellW / 2;
      const main = { key: a.key, a, isSub: false, x: cx, y, r: 50, status, fade, g };
      nodes.push(main);
      subs.forEach(({ s, status: st, fade: f }, j) => {
        const row = Math.floor(j / SUBS_PER_ROW);
        const inRow = Math.min(subs.length - row * SUBS_PER_ROW, SUBS_PER_ROW);
        const col = j % SUBS_PER_ROW;
        nodes.push({
          key: s.key, a: s, isSub: true, parent: main, r: 36, status: st, fade: f, g,
          x: cx + (col - (inRow - 1) / 2) * SUB_GAP_X,
          y: y + SUB_TOP + row * SUB_GAP_Y + Math.abs(col - (inRow - 1) / 2) * 24,
        });
      });
      const rows = Math.ceil(subs.length / SUBS_PER_ROW);
      rowDepth = Math.max(rowDepth, rows ? SUB_TOP + (rows - 1) * SUB_GAP_Y + SUB_GAP_Y : 0);
      x += cellW;
    }
    y += rowDepth + 700;
  }

  const boxes = [];
  const bubbles = [];
  for (const nd of nodes) {
    const tools = recentTools(nd.key, T, nd.status);
    // A main agent's calls orbit it on the left (its message bubble sits on the right);
    // a subagent's calls stack in a column under its label, with its bubble below them.
    tools.forEach((b, i) => {
      if (nd.isSub) {
        boxes.push({ ...b, node: nd, x: nd.x, y: nd.y + nd.r + 132 + i * 64 });
      } else {
        const ang = (MAIN_SLOTS[i % MAIN_SLOTS.length] * Math.PI) / 180;
        boxes.push({ ...b, node: nd, x: nd.x + Math.cos(ang) * 290, y: nd.y + Math.sin(ang) * 150 + (i >= MAIN_SLOTS.length ? 64 : 0) });
      }
    });
    const msg = lastMessage(nd.key, T);
    if (msg) {
      bubbles.push(nd.isSub
        ? { e: msg, node: nd, x: nd.x, y: nd.y + nd.r + 132 + tools.length * 64 + 30, sub: true }
        : { e: msg, node: nd, x: nd.x + nd.r + 36, y: nd.y });
    }
  }
  return { T, groups, nodes, rows, boxes, bubbles };
}

/* ---------- overlay (HTML on top of the canvas, same camera) ---------- */

const ctxWindow = (a) => (a.context > 200e3 ? 1e6 : 200e3);
const fmtUsd = (n) => (n == null ? '' : n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(n < 1 ? 3 : 2)}` : `$${Math.round(n)}`);

function categoryShare(key) {
  const counts = {};
  let total = 0;
  for (const e of state.events.get(key) || []) if (e.kind === 'tool') { counts[e.cat] = (counts[e.cat] || 0) + 1; total++; }
  return CATS.filter((c) => counts[c]).map((c) => ({ cat: c, share: counts[c] / total }));
}

function labelHTML(nd) {
  const a = nd.a;
  const fill = Math.min(1, (a.context || 0) / ctxWindow(a));
  const segs = categoryShare(a.key).map((s) => `<i style="width:${(fill * s.share * 100).toFixed(2)}%;background:${CAT_COLOR[s.cat]}"></i>`).join('')
    || `<i style="width:${(fill * 100).toFixed(2)}%;background:${nd.isSub ? ROLE.sub : ROLE.main}"></i>`;
  const name = nd.isSub ? a.type : a.name;
  return `<div class="fl-name" title="${esc(nd.isSub ? `${a.type} · ${a.description}` : a.title || a.name)}">${esc(name)}</div>
    ${nd.isSub && a.description ? `<div class="fl-desc">${esc(a.description)}</div>` : ''}
    ${!nd.isSub && inWorktree(a) ? '<div class="fl-desc">worktree</div>' : ''}
    <div class="fl-ctx">${segs}</div>
    <div class="fl-ctx-t">${fmtK(a.context)} / ${fmtK(ctxWindow(a))} tokens</div>`;
}

function boxHTML(b) {
  const e = b.e;
  const r = e.result;
  let st;
  if (b.done) st = `<span class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗ failed'} ${fmtMs(r.ms)}</span>`;
  else if (FL.review) st = `<span class="run">● running ${fmtDur(nowT() - e.t)}</span>`;
  else st = `<span class="run">● running <span data-since="${Number(e.t) || 0}"></span></span>`;
  const open = FL.open.has(e.id);
  return `<div class="fl-box-h"><b>${esc(e.label)}:</b> ${esc(e.summary)}</div>
    <div class="fl-box-m">${fmtTime(e.t)} ${st}</div>
    ${open ? `<pre>${esc(e.detail)}</pre>${r && b.done ? `<pre class="res ${r.ok ? '' : 'err'}">${esc(r.text || '(no output)')}</pre>` : ''}` : ''}`;
}

function bubbleHTML(b) {
  const who = b.e.kind === 'say' ? 'CLAUDE' : b.node.isSub ? 'TASK' : 'YOU';
  return `<div class="fl-bubble-h">${who} · ${fmtTime(b.e.t)}</div><div class="fl-bubble-t">${esc(b.e.text)}</div>`;
}

// A finished tool call fades over its last 10s, and with the agent it belongs to.
const boxFade = (b) => (b.done && !FL.open.has(b.e.id) ? Math.min(1, (BOX_LINGER_MS - b.age) / 10e3) : 1) * b.node.fade;

function overlayItems(m) {
  const items = [];
  for (const row of m.rows) {
    items.push({ key: `p:${row.g.id}`, cls: 'fl-row', x: row.x, y: row.y, anchor: 'left', opacity: row.fade,
      html: `<b>${esc(row.g.name)}</b><span>${esc(row.g.cwd)}</span>${row.g.id !== 'unknown' ? `<a href="#/projects/${encodeURIComponent(row.g.id)}">setup →</a>` : ''}` });
  }
  for (const nd of m.nodes) {
    const sel = nd.key === FL.selected ? 'sel' : '';
    items.push({ key: `n:${nd.key}`, cls: `fl-label ${nd.isSub ? 'sub' : ''} s-${nd.status} ${sel}`, x: nd.x, y: nd.y + nd.r + 54, html: labelHTML(nd), select: nd.key, opacity: nd.fade });
    if (nd.a.cost != null) items.push({ key: `c:${nd.key}`, cls: `fl-cost ${nd.isSub ? 'sub' : ''}`, x: nd.x, y: nd.y - nd.r - 30, html: `~${esc(fmtUsd(nd.a.cost))}`, select: nd.key, opacity: nd.fade });
  }
  for (const b of m.boxes) {
    const st = b.done ? (b.e.result.ok ? 'ok' : 'err') : 'run';
    items.push({ key: `t:${b.e.id}`, cls: `fl-box c-${b.e.cat} ${st} ${FL.open.has(b.e.id) ? 'open' : ''}`, x: b.x, y: b.y, html: boxHTML(b), opacity: boxFade(b), toggle: b.e.id });
  }
  for (const b of m.bubbles) {
    items.push({ key: `b:${b.node.key}`, cls: `fl-bubble ${b.e.kind} ${b.sub ? 'below' : ''}`, x: b.x, y: b.y, anchor: b.sub ? 'top' : 'left', html: bubbleHTML(b), opacity: b.node.fade });
  }
  return items;
}

function syncOverlay(items) {
  const layer = $('#fl-world');
  const seen = new Set();
  for (const it of items) {
    seen.add(it.key);
    let el = FL.overlay.get(it.key);
    if (!el) {
      el = document.createElement('div');
      el.style.animation = 'flIn .45s ease-out';
      layer.appendChild(el);
      FL.overlay.set(it.key, el);
    }
    if (el._html !== it.html) { el.innerHTML = it.html; el._html = it.html; }
    if (el.className !== it.cls) el.className = it.cls;
    el.dataset.select = it.select || '';
    el.dataset.toggle = it.toggle || '';
    const shift = it.anchor === 'left' ? '0, -50%' : it.anchor === 'top' ? '-50%, 0' : '-50%, -50%';
    el.style.transform = `translate(${it.x}px, ${it.y}px) translate(${shift})`;
    el.style.opacity = it.opacity ?? 1;
  }
  for (const [k, el] of FL.overlay) if (!seen.has(k)) { el.remove(); FL.overlay.delete(k); }
}

/* ---------- canvas drawing ---------- */

const hexPath = (g, x, y, r) => {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    g[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
};
const rgba = (hex, a) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const bezier = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
};

function drawScene(time) {
  const cv = $('#fl-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  // Stars drift slightly with the camera for depth.
  for (const s of FL.stars) {
    const x = (((s.x * W - FL.cam.x * 0.03) % W) + W) % W;
    const y = (((s.y * H - FL.cam.y * 0.03) % H) + H) % H;
    g.fillStyle = `rgba(190,205,255,${0.18 + 0.22 * Math.sin(time / 1400 + s.p) ** 2})`;
    g.fillRect(x, y, s.s, s.s);
  }

  const m = FL.model;
  if (!m) return;
  const { x: cx, y: cy, z } = FL.cam;
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cx * z), dpr * (H / 2 - cy * z));

  // Parent → subagent edges, with particles flowing while the subagent works.
  for (const nd of m.nodes) {
    if (!nd.parent) continue;
    const p0 = [nd.parent.x, nd.parent.y + nd.parent.r];
    const p3 = [nd.x, nd.y - nd.r];
    const p1 = [p0[0], p0[1] + (p3[1] - p0[1]) * 0.6];
    const p2 = [p3[0], p3[1] - (p3[1] - p0[1]) * 0.5];
    const live = nd.status === 'working';
    g.globalAlpha = nd.fade;
    g.strokeStyle = rgba(ROLE.sub, live ? 0.5 : 0.16);
    g.lineWidth = live ? 1.6 : 1;
    g.beginPath(); g.moveTo(...p0); g.bezierCurveTo(...p1, ...p2, ...p3); g.stroke();
    if (live) {
      g.fillStyle = ROLE.sub;
      for (let k = 0; k < 3; k++) {
        const [px, py] = bezier(p0, p1, p2, p3, ((time / 1800 + k / 3) % 1));
        g.beginPath(); g.arc(px, py, 2.6, 0, Math.PI * 2); g.fill();
      }
    }
  }

  // Agent → tool call threads, and a slow sweep around calls still running.
  for (const b of m.boxes) {
    const color = CAT_COLOR[b.e.cat] || CAT_COLOR.other;
    const nd = b.node;
    const dx = b.x - nd.x;
    const dy = b.y - nd.y;
    const d = Math.hypot(dx, dy) || 1;
    g.globalAlpha = boxFade(b);
    g.strokeStyle = rgba(color, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(nd.x + (dx / d) * nd.r, nd.y + (dy / d) * nd.r);
    g.quadraticCurveTo(nd.x + dx / 2 - dy * 0.15, nd.y + dy / 2 + dx * 0.15, b.x, b.y);
    g.stroke();
    if (!b.done && !nd.isSub) {
      const a0 = time / 900;
      g.strokeStyle = rgba(color, 0.32);
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(b.x, b.y, 150, a0, a0 + Math.PI * 1.25); g.stroke();
    }
  }

  // Agents.
  for (const nd of m.nodes) {
    const role = nd.isSub ? ROLE.sub : ROLE.main;
    const working = nd.status === 'working';
    const waiting = nd.status === 'waiting';
    const dim = nd.status === 'offline' ? 0.35 : working || waiting ? 1 : 0.6;
    const r = nd.r;
    g.globalAlpha = nd.fade;

    if (working) {
      const glow = g.createRadialGradient(nd.x, nd.y, r * 0.6, nd.x, nd.y, r * 2.4);
      glow.addColorStop(0, rgba(role, 0.22 + 0.08 * Math.sin(time / 500)));
      glow.addColorStop(1, rgba(role, 0));
      g.fillStyle = glow;
      g.beginPath(); g.arc(nd.x, nd.y, r * 2.4, 0, Math.PI * 2); g.fill();
    }
    if (waiting) {
      g.strokeStyle = rgba(COLOR.waiting || '#ffb547', 0.35 + 0.35 * Math.sin(time / 300));
      g.lineWidth = 2;
      g.beginPath(); g.arc(nd.x, nd.y, r + 24, 0, Math.PI * 2); g.stroke();
    }
    if (nd.key === FL.selected) {
      g.setLineDash([4, 6]);
      g.strokeStyle = rgba('#dbe2ec', 0.35);
      g.lineWidth = 1;
      g.beginPath(); g.arc(nd.x, nd.y, r + 30, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }

    // Activity ring: the mix of recent tool categories, spinning while the agent works.
    const recent = (state.events.get(nd.key) || []).filter((e) => e.kind === 'tool' && e.t <= m.T).slice(-14);
    if (recent.length) {
      const span = Math.PI * 0.9;
      const start = working ? time / 1600 : -Math.PI / 2 - span / 2;
      const step = span / recent.length;
      g.lineWidth = 3;
      recent.forEach((e, i) => {
        g.strokeStyle = rgba(CAT_COLOR[e.cat] || CAT_COLOR.other, (working ? 0.9 : 0.4) * dim);
        g.beginPath(); g.arc(nd.x, nd.y, r + 13, start + i * step, start + (i + 1) * step - 0.04); g.stroke();
      });
    }

    hexPath(g, nd.x, nd.y, r);
    g.fillStyle = 'rgba(9,13,26,.92)';
    g.fill();
    g.strokeStyle = rgba(nd.status === 'offline' ? '#556072' : role, dim);
    g.lineWidth = working ? 3 : 2;
    if (working) { g.shadowColor = role; g.shadowBlur = 18; }
    g.stroke();
    g.shadowBlur = 0;

    // Icon: a spark for a main agent, a small gear for a subagent.
    g.strokeStyle = rgba(role, 0.85 * dim);
    g.lineWidth = 2;
    if (!nd.isSub) {
      const len = r * 0.36;
      const spin = working ? time / 2400 : 0;
      for (let k = 0; k < 6; k++) {
        const a = spin + (k * Math.PI) / 6;
        g.beginPath(); g.moveTo(nd.x - Math.cos(a) * len, nd.y - Math.sin(a) * len); g.lineTo(nd.x + Math.cos(a) * len, nd.y + Math.sin(a) * len); g.stroke();
      }
    } else {
      g.beginPath(); g.arc(nd.x, nd.y, r * 0.17, 0, Math.PI * 2); g.stroke();
      for (let k = 0; k < 6; k++) {
        const a = (working ? time / 1200 : 0) + (k * Math.PI) / 3;
        g.beginPath(); g.moveTo(nd.x + Math.cos(a) * r * 0.24, nd.y + Math.sin(a) * r * 0.24); g.lineTo(nd.x + Math.cos(a) * r * 0.34, nd.y + Math.sin(a) * r * 0.34); g.stroke();
      }
    }
  }
  g.globalAlpha = 1;
}

/* ---------- camera ---------- */

function fitTarget() {
  const m = FL.model;
  const stage = $('#fl-stage');
  if (!m?.nodes.length || !stage) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const nd of m.nodes) {
    x0 = Math.min(x0, nd.x - (nd.isSub ? 190 : 470));
    x1 = Math.max(x1, nd.x + (nd.isSub ? 190 : 480));
    y0 = Math.min(y0, nd.y - (nd.isSub ? 90 : 300));
    y1 = Math.max(y1, nd.y + (nd.isSub ? 420 : 260));
  }
  // Fit into the area not covered by the side panel and the timeline.
  const panelW = FL.panel && stage.clientWidth > 900 ? 360 : 0;
  const W = stage.clientWidth - panelW;
  const H = stage.clientHeight - (FL.timeline ? 150 : 80);
  const z = Math.max(0.2, Math.min(1, W / (x1 - x0), H / (y1 - y0)));
  return { x: (x0 + x1) / 2 + panelW / 2 / z, y: (y0 + y1) / 2 + (FL.timeline ? 20 : -10) / z, z };
}

function focusOn(key) {
  const nd = FL.model?.nodes.find((n) => n.key === key);
  if (!nd) return;
  FL.follow = false;
  FL.target = { x: nd.x + 120, y: nd.y + 60, z: Math.max(FL.cam.z, 0.85) };
}

function applyCamera() {
  const stage = $('#fl-stage');
  const target = FL.follow ? fitTarget() : FL.target;
  if (target) {
    const k = 0.12;
    FL.cam.x += (target.x - FL.cam.x) * k;
    FL.cam.y += (target.y - FL.cam.y) * k;
    FL.cam.z += (target.z - FL.cam.z) * k;
    if (!FL.follow && Math.abs(target.x - FL.cam.x) < 0.5 && Math.abs(target.z - FL.cam.z) < 0.002) FL.target = null;
  }
  const { x, y, z } = FL.cam;
  $('#fl-world').style.transform = `translate(${stage.clientWidth / 2 - x * z}px, ${stage.clientHeight / 2 - y * z}px) scale(${z})`;
  $('#fl-zoom').textContent = `${Math.round(z * 100)}%`;
}

/* ---------- chrome: focus pill, stats, panels, timeline ---------- */

function allNodesAgents() {
  return (FL.model?.nodes || []).map((n) => n.a);
}

function renderChrome() {
  const m = FL.model;
  const agents = allNodesAgents();
  const sel = m?.nodes.find((n) => n.key === FL.selected);

  // Focus pill (top left).
  const pill = $('#fl-focus-btn');
  if (sel) {
    const msg = sel.a.lastSay?.text || nowText(sel.a) || '';
    pill.innerHTML = `<span class="dot s-${sel.status}"></span><b>${esc(sel.isSub ? sel.a.type : sel.a.name)}</b><span class="fl-focus-msg">${esc(msg)}</span><span class="fl-caret">▾</span>`;
  } else {
    pill.innerHTML = `<span class="dot"></span><b>No agent selected</b><span class="fl-caret">▾</span>`;
  }
  const menu = $('#fl-menu');
  if (!menu.hidden) {
    menu.innerHTML = (m?.nodes || []).map((n) => `<button data-pick="${esc(n.key)}" class="${n.isSub ? 'sub' : ''}">
      <span class="dot s-${n.status}"></span><b>${esc(n.isSub ? n.a.type : n.a.name)}</b><span>${esc(n.g.name)}</span></button>`).join('') || '<div class="fl-none">No agents in view</div>';
  }

  // Stats and toggles (top right).
  const cost = agents.reduce((s, a) => s + (a.cost || 0), 0);
  const tokens = agents.reduce((s, a) => s + (a.outTokens || 0), 0);
  $('#fl-stats').innerHTML = `<span>${agents.length} agent${agents.length === 1 ? '' : 's'}</span><span>${fmtK(tokens)} tokens out</span>${agents.some((a) => a.cost != null) ? `<span>~${esc(fmtUsd(cost))}</span>` : ''}`;
  for (const b of document.querySelectorAll('#fl-toggles [data-panel]')) b.classList.toggle('on', FL.panel === b.dataset.panel);
  $('#fl-tl-btn').classList.toggle('on', FL.timeline);
  $('#fl-ended').classList.toggle('on', FL.ended);

  // Project picker.
  const groups = flGroups(true);
  const options = `<option value="">All projects</option>${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${g.agents.filter((a) => a.live).length} live)</option>`).join('')}`;
  const pick = $('#fl-pick');
  if (pick._html !== options) { pick.innerHTML = options; pick._html = options; }
  pick.value = FL.project || '';

  renderPanel(agents, sel);
  $('#fl-empty').hidden = !!m?.nodes.length;
  if (!m?.nodes.length) {
    $('#fl-empty').innerHTML = FL.project
      ? `Nothing is running in this project right now.${FL.ended ? '' : ' Turn on <b>Ended</b> to see recent sessions.'}`
      : 'No agents are running. Start Claude Code in any folder and it shows up here.';
  }
}

function renderPanel(agents, sel) {
  const panel = $('#fl-panel');
  panel.hidden = !FL.panel;
  if (!FL.panel) return;
  let html = '';
  if (FL.panel === 'cost') {
    const priced = agents.filter((a) => a.cost != null);
    const total = priced.reduce((s, a) => s + a.cost, 0);
    const max = Math.max(...priced.map((a) => a.cost), 0.000001);
    html += `<div class="fl-p-h"><b>~${esc(fmtUsd(total))}</b><span>${fmtK(agents.reduce((s, a) => s + (a.outTokens || 0), 0))} tokens out</span></div>`;
    html += priced.length
      ? priced.sort((x, y) => y.cost - x.cost).map((a) => `<div class="fl-bar" data-pick="${esc(a.key)}"><i style="width:${((a.cost / max) * 100).toFixed(1)}%"></i>
          <span>${esc(a.parent ? a.type : a.name)}</span><b>${esc(fmtUsd(a.cost))}</b></div>`).join('')
      : '<div class="fl-none">Costs appear once Claude Code records them at the end of a turn.</div>';
    const byTool = new Map();
    for (const a of agents) for (const e of eventsAt(a.key, nowT())) {
      if (e.kind !== 'tool') continue;
      const t = byTool.get(e.label) || { n: 0, ms: 0, cat: e.cat };
      t.n++;
      t.ms += e.result?.ms || 0;
      byTool.set(e.label, t);
    }
    const tools = [...byTool].sort((x, y) => y[1].n - x[1].n).slice(0, 12);
    const tmax = Math.max(...tools.map(([, t]) => t.n), 1);
    html += `<div class="fl-p-sub">BY TOOL · calls and time</div>${tools.map(([label, t]) => `<div class="fl-bar c-${t.cat}"><i style="width:${((t.n / tmax) * 100).toFixed(1)}%"></i>
      <span>${esc(label)}</span><b>${t.n}× · ${fmtMs(t.ms) || '0s'}</b></div>`).join('')}`;
    html += '<div class="fl-p-note">Costs are estimates priced with the per-model rates Claude Code records.</div>';
  } else if (FL.panel === 'chat') {
    if (!sel) html = '<div class="fl-none">Select an agent to read its conversation.</div>';
    else {
      const evs = eventsAt(sel.key, nowT()).slice(-80);
      html = `<div class="fl-p-h"><b>${esc(sel.isSub ? sel.a.type : sel.a.name)}</b><a href="#/live/${encodeURIComponent(sel.key)}">open ↗</a></div><div class="fl-chat">${evs.map((e) => {
        if (e.kind === 'tool') return `<div class="fl-c-tool c-${e.cat}"><span class="chip">${esc(e.label)}</span>${esc(e.summary)}${e.result ? (e.result.ok ? ' <i class="ok">✓</i>' : ' <i class="err">✗</i>') : ''}</div>`;
        if (e.kind === 'say' || e.kind === 'prompt') return `<div class="fl-c-msg ${e.kind}"><b>${e.kind === 'say' ? 'CLAUDE' : sel.isSub ? 'TASK' : 'YOU'}</b> ${esc(e.text)}</div>`;
        return `<div class="fl-c-note">${esc(e.text)}</div>`;
      }).join('') || '<div class="fl-none">No activity recorded yet.</div>'}</div>`;
    }
  } else if (FL.panel === 'files') {
    const files = new Map();
    for (const a of agents) for (const e of eventsAt(a.key, nowT())) {
      if (e.kind !== 'tool' || !['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.name)) continue;
      const p = String(e.detail || '').split('\n')[0].replace(/ \(from line \d+\)$/, '');
      if (!p) continue;
      const f = files.get(p) || { r: 0, w: 0 };
      if (e.name === 'Read') f.r++; else f.w++;
      files.set(p, f);
    }
    const list = [...files].sort((x, y) => (y[1].r + y[1].w * 2) - (x[1].r + x[1].w * 2)).slice(0, 40);
    const max = Math.max(...list.map(([, f]) => f.r + f.w * 2), 1);
    html = `<div class="fl-p-h"><b>${files.size} file${files.size === 1 ? '' : 's'}</b><span>read / changed</span></div>${list.map(([p, f]) => {
      const parts = p.split(/[\\/]/);
      return `<div class="fl-bar fl-file" title="${esc(p)}"><i style="width:${(((f.r + f.w * 2) / max) * 100).toFixed(1)}%"></i>
        <span>${esc(parts.pop())} <em>${esc(parts.slice(-2).join('/'))}</em></span><b>${f.r ? `R${f.r}` : ''}${f.w ? ` <u>E${f.w}</u>` : ''}</b></div>`;
    }).join('') || '<div class="fl-none">No files read or changed yet.</div>'}`;
  }
  if (panel._html !== html) {
    const chat = panel.querySelector('.fl-chat');
    const atBottom = !chat || chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
    panel.innerHTML = html;
    panel._html = html;
    const next = panel.querySelector('.fl-chat');
    if (next && atBottom) next.scrollTop = next.scrollHeight;
  }
}

function timelineRange() {
  const keys = (FL.model?.nodes || []).map((n) => n.key);
  let t0 = Infinity;
  for (const k of keys) { const e = (state.events.get(k) || [])[0]; if (e) t0 = Math.min(t0, e.t); }
  const t1 = Date.now();
  if (!isFinite(t0)) t0 = t1 - 60e3;
  return { keys, t0: Math.max(t0, t1 - MAX_SPAN_MS), t1 };
}

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

function drawTimeline() {
  const bar = $('#fl-timeline');
  bar.hidden = !FL.timeline;
  if (!FL.timeline) return;
  const { keys, t0, t1 } = timelineRange();
  const T = nowT();
  const cv = $('#fl-track');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const X = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (W - 8) + 4;
  g.fillStyle = 'rgba(255,255,255,.07)';
  g.fillRect(0, H / 2 - 1, W, 2);
  let count = 0;
  for (const k of keys) {
    for (const e of state.events.get(k) || []) {
      if (e.t < t0) continue;
      const past = e.t <= T;
      if (past) count++;
      g.globalAlpha = past ? 1 : 0.25;
      g.fillStyle = e.kind === 'tool' ? CAT_COLOR[e.cat] || CAT_COLOR.other : e.kind === 'prompt' ? COLOR.text : e.kind === 'say' ? ROLE.main : '#556072';
      g.beginPath(); g.arc(X(e.t), H / 2, e.kind === 'prompt' ? 4 : 3, 0, Math.PI * 2); g.fill();
    }
  }
  g.globalAlpha = 1;
  if (FL.review) {
    g.fillStyle = '#dbe2ec';
    g.fillRect(X(T) - 1, 2, 2, H - 4);
  }
  $('#fl-live').className = `fl-live ${FL.review ? 'off' : ''}`;
  $('#fl-live').innerHTML = FL.review ? '<i></i>LIVE' : '<i></i>LIVE';
  $('#fl-clock').textContent = fmtClock(T - t0);
  $('#fl-count').textContent = count;
  $('#fl-review').textContent = !FL.review ? '⏵ Review' : FL.review.playing ? '⏸ Pause' : '⏵ Play';
  FL.range = { t0, t1 };
}

/* ---------- loop ---------- */

function ensureStage(host) {
  if ($('#fl-stage')) return;
  host.innerHTML = `
    <div class="fl-stage" id="fl-stage">
      <canvas id="fl-canvas"></canvas>
      <div class="fl-world" id="fl-world"></div>
      <div class="fl-ui fl-focus">
        <button class="fl-focus-btn" id="fl-focus-btn"></button>
        <div class="fl-menu" id="fl-menu" hidden></div>
      </div>
      <div class="fl-ui fl-top">
        <div class="fl-stats" id="fl-stats"></div>
        <select class="fl-pick" id="fl-pick" aria-label="Project"></select>
        <button class="fl-btn" id="fl-ended" title="Keep ended sessions and finished subagents on the map instead of fading them out">Ended</button>
        <div class="fl-group"><button class="fl-btn" data-zoom="-1" title="Zoom out">−</button><button class="fl-btn" id="fl-zoom" data-zoom="0" title="Fit everything">100%</button><button class="fl-btn" data-zoom="1" title="Zoom in">+</button></div>
        <div class="fl-group" id="fl-toggles"><button class="fl-btn" data-panel="files">Files</button><button class="fl-btn" data-panel="chat">Chat</button><button class="fl-btn" data-panel="cost">$Cost</button></div>
        <button class="fl-btn" id="fl-tl-btn">Timeline</button>
      </div>
      <aside class="fl-ui fl-panel" id="fl-panel" hidden></aside>
      <div class="fl-empty" id="fl-empty" hidden></div>
      <div class="fl-ui fl-timeline" id="fl-timeline">
        <button class="fl-live" id="fl-live" title="Back to live"></button>
        <span class="fl-clock" id="fl-clock">0:00</span>
        <canvas class="fl-track" id="fl-track" title="Click or drag to review a moment"></canvas>
        <span class="fl-count" id="fl-count">0</span>
        <button class="fl-btn" id="fl-review">⏵ Review</button>
      </div>
    </div>`;
  FL.overlay.clear();
  wireStage();
}

function rebuild() {
  FL.model = buildModel();
  if (!FL.model.nodes.some((n) => n.key === FL.selected)) {
    FL.selected = (FL.model.nodes.find((n) => n.status === 'working' && !n.isSub) || FL.model.nodes[0])?.key || null;
  }
  syncOverlay(overlayItems(FL.model));
  renderChrome();
  drawTimeline();
  FL.dirty = false;
  FL.builtAt = performance.now();
}

function frame(time) {
  FL.raf = 0;
  const host = $('#view-canvas');
  if (host.hidden) return;
  if (FL.review?.playing) {
    FL.review.t += (time - (FL.review.last || time)) * FL.review.speed;
    FL.review.last = time;
    if (FL.review.t >= Date.now()) FL.review = null;
    FL.dirty = true;
  }
  if (FL.dirty || time - FL.builtAt > (FL.review ? 120 : 500)) rebuild();
  applyCamera();
  drawScene(time);
  FL.raf = requestAnimationFrame(frame);
}

function startLoop() {
  if (!FL.raf) FL.raf = requestAnimationFrame(frame);
}

// Called by app.js whenever agents or events change.
function renderCanvas() {
  FL.dirty = true;
  if (!$('#view-canvas').hidden) startLoop();
}
const canvasActivity = renderCanvas;

function showCanvas(project) {
  const host = $('#view-canvas');
  if ((project || null) !== FL.project) { FL.follow = true; FL.target = null; }
  FL.project = project || null;
  host.style.setProperty('--top', `${$('.top').getBoundingClientRect().bottom}px`);
  ensureStage(host);
  FL.dirty = true;
  startLoop();
}

/* ---------- interaction ---------- */

function setReview(t, playing) {
  const { t0 } = FL.range || timelineRange();
  if (t == null) { FL.review = null; FL.dirty = true; return; }
  const span = Date.now() - t0;
  FL.review = { t: Math.min(Math.max(t, t0), Date.now()), playing, speed: Math.max(4, span / 60e3), last: 0 };
  FL.dirty = true;
}

function wireStage() {
  const stage = $('#fl-stage');

  stage.addEventListener('click', (ev) => {
    const t = ev.target;
    const pick = t.closest('[data-pick]');
    if (pick) {
      FL.selected = pick.dataset.pick;
      $('#fl-menu').hidden = true;
      focusOn(FL.selected);
    } else if (t.closest('#fl-focus-btn')) {
      $('#fl-menu').hidden = !$('#fl-menu').hidden;
    } else if (t.closest('[data-panel]')) {
      const p = t.closest('[data-panel]').dataset.panel;
      FL.panel = FL.panel === p ? '' : p;
      store.set('cv.panel', FL.panel);
    } else if (t.closest('#fl-tl-btn')) {
      FL.timeline = !FL.timeline;
      store.set('cv.timeline', FL.timeline ? '1' : '0');
    } else if (t.closest('#fl-ended')) {
      FL.ended = !FL.ended;
      store.set('cv.ended', FL.ended ? '1' : '0');
    } else if (t.closest('[data-zoom]')) {
      const step = Number(t.closest('[data-zoom]').dataset.zoom);
      if (!step) { FL.follow = true; FL.target = null; } else {
        FL.follow = false;
        FL.target = { x: FL.cam.x, y: FL.cam.y, z: Math.min(2, Math.max(0.15, FL.cam.z * (step > 0 ? 1.25 : 0.8))) };
      }
    } else if (t.closest('#fl-live')) {
      setReview(null);
    } else if (t.closest('#fl-review')) {
      if (!FL.review) setReview((FL.range || timelineRange()).t0, true);
      else { FL.review.playing = !FL.review.playing; FL.review.last = 0; }
    } else if (t.closest('[data-toggle]:not([data-toggle=""])') && !t.closest('pre')) {
      const id = t.closest('[data-toggle]').dataset.toggle;
      if (FL.open.has(id)) FL.open.delete(id); else FL.open.add(id);
    } else if (t.closest('[data-select]:not([data-select=""])')) {
      FL.selected = t.closest('[data-select]').dataset.select;
    } else if (!t.closest('.fl-menu')) {
      $('#fl-menu').hidden = true;
      return;
    } else {
      return;
    }
    FL.dirty = true;
  });

  $('#fl-pick').addEventListener('change', (ev) => {
    location.hash = ev.target.value ? `#/canvas/${encodeURIComponent(ev.target.value)}` : '#/canvas';
  });

  // Drag the background to pan; a click without dragging selects the agent under the pointer.
  stage.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.fl-ui, .fl-box, .fl-label, .fl-bubble, .fl-cost, .fl-row a')) return;
    FL.drag = { x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY, moved: false };
    stage.setPointerCapture(ev.pointerId);
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!FL.drag) return;
    const dx = ev.clientX - FL.drag.x;
    const dy = ev.clientY - FL.drag.y;
    if (Math.hypot(ev.clientX - FL.drag.sx, ev.clientY - FL.drag.sy) > 4) FL.drag.moved = true;
    if (FL.drag.moved) {
      FL.follow = false;
      FL.target = null;
      FL.cam.x -= dx / FL.cam.z;
      FL.cam.y -= dy / FL.cam.z;
    }
    FL.drag.x = ev.clientX;
    FL.drag.y = ev.clientY;
  });
  stage.addEventListener('pointerup', (ev) => {
    const d = FL.drag;
    FL.drag = null;
    stage.classList.remove('panning');
    if (!d || d.moved) return;
    const rect = stage.getBoundingClientRect();
    const wx = FL.cam.x + (ev.clientX - rect.left - rect.width / 2) / FL.cam.z;
    const wy = FL.cam.y + (ev.clientY - rect.top - rect.height / 2) / FL.cam.z;
    const hit = FL.model?.nodes.find((n) => Math.hypot(n.x - wx, n.y - wy) < n.r + 12);
    if (hit) { FL.selected = hit.key; FL.dirty = true; }
    $('#fl-menu').hidden = true;
  });

  // Wheel zooms around the pointer, like a map.
  stage.addEventListener('wheel', (ev) => {
    if (ev.target.closest('.fl-panel, .fl-menu, .fl-box pre, .fl-bubble')) return;
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    const sx = ev.clientX - rect.left - rect.width / 2;
    const sy = ev.clientY - rect.top - rect.height / 2;
    const wx = FL.cam.x + sx / FL.cam.z;
    const wy = FL.cam.y + sy / FL.cam.z;
    const z = Math.min(2, Math.max(0.15, FL.cam.z * Math.exp(-ev.deltaY * 0.0015)));
    FL.follow = false;
    FL.target = null;
    FL.cam = { x: wx - sx / z, y: wy - sy / z, z };
  }, { passive: false });

  // Timeline: click or drag to review a moment.
  const track = $('#fl-track');
  const scrub = (ev) => {
    const rect = track.getBoundingClientRect();
    const { t0, t1 } = FL.range || timelineRange();
    setReview(t0 + ((ev.clientX - rect.left - 4) / Math.max(rect.width - 8, 1)) * (t1 - t0), false);
  };
  track.addEventListener('pointerdown', (ev) => { track.setPointerCapture(ev.pointerId); track._down = true; scrub(ev); });
  track.addEventListener('pointermove', (ev) => { if (track._down) scrub(ev); });
  track.addEventListener('pointerup', () => { track._down = false; });

  window.addEventListener('resize', () => $('#view-canvas').style.setProperty('--top', `${$('.top').getBoundingClientRect().bottom}px`));
}
