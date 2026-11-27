// Hub mode: keeps the agents that other machines report (see reporter.js) next to this PC's own.
// Each machine authenticates with its own key; the hub names the machine from the key, never
// from what the reporter says about itself, and prefixes its agent keys with that name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { levelOf, minLevel, shareAgents, shareAllEvents, shareEvents, shareOthers } from './share.js';

export const PROTOCOL = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const OFFLINE_MS = 20e3;       // a machine silent this long is shown as disconnected…
const FORGET_MS = 3 * 3600e3;  // …and its sessions move to the archive this long after its last report
const DUPLICATE_MS = 15e3;     // another reporter on the same key is refused while the first is active
const MAX_EVENTS = 200;        // per agent key, like the snapshot a browser gets on connect

// Reporters older than this don't send the freeText / nameFromPrompt flags, so a hub that lowers
// their sharing level can't drop what those mark; the dashboard asks for an update.
export const MIN_REPORTER = '0.5.1';
export const versionBelow = (v, min) => {
  const a = String(v || '').split(/[.-]/).map(Number);
  const b = min.split('.').map(Number);
  if (!(a.length >= 3 && a.slice(0, 3).every(Number.isInteger))) return true; // unknown version
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

export function newMachineKey(name) {
  if (!NAME_RE.test(name)) throw new Error('A machine name may only use letters, digits, ".", "_" and "-" (max 63).');
  const key = `ahk_${crypto.randomBytes(32).toString('base64url')}`;
  return { key, entry: { name, sha256: sha256(key).toString('hex') } };
}

// The hub's keys file: { "machines": [{ "name", "sha256", "share"? }] }. Only hashes are stored.
// `share` caps what the hub keeps from that machine. The file is re-read when it changes, so
// removing an entry revokes that machine without a restart. `inline` is the same JSON given
// directly ($AGENT_HUB_MACHINES, for containers configured through a form); it is fixed until restart.
export class Keyring {
  constructor(file, inline) {
    this.file = file;
    this.entries = [];
    this.mtime = -1;
    this.checkedAt = 0;
    if (inline != null) this.load(inline, 'AGENT_HUB_MACHINES');
    else this.read(fs.statSync(file).mtimeMs); // a missing or broken file fails at startup
  }

  read(mtime) {
    this.load(fs.readFileSync(this.file, 'utf8'), this.file);
    this.mtime = mtime;
  }

  load(text, source) {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j?.machines;
    if (!Array.isArray(list)) throw new Error(`${source}: expected { "machines": [...] }`);
    const names = new Set();
    this.entries = list.map((e, i) => {
      const where = `${source}: machines[${i}]`;
      if (!NAME_RE.test(e?.name || '')) throw new Error(`${where}: invalid name`);
      if (names.has(e.name)) throw new Error(`${where}: duplicate name "${e.name}"`);
      if (!/^[0-9a-f]{64}$/i.test(e.sha256 || '')) throw new Error(`${where}: "sha256" must be the 64-hex-digit hash printed by --new-key`);
      if (e.share != null && !levelOf(e.share)) throw new Error(`${where}: "share" must be metadata, activity or full`);
      names.add(e.name);
      return { name: e.name, hash: Buffer.from(e.sha256, 'hex'), share: e.share || 'full' };
    });
  }

  refresh() {
    if (!this.file || Date.now() - this.checkedAt < 2000) return;
    this.checkedAt = Date.now();
    try {
      const { mtimeMs } = fs.statSync(this.file);
      if (mtimeMs !== this.mtime) { this.read(mtimeMs); console.log(`[hub] keys file reloaded: ${this.entries.length} machine(s)`); }
    } catch (e) {
      console.error(`[hub] keys file unreadable, keeping the previous one: ${e.message}`);
    }
  }

  match(key) {
    this.refresh();
    if (typeof key !== 'string' || !key) return null;
    const h = sha256(key);
    let found = null;
    for (const e of this.entries) if (crypto.timingSafeEqual(h, e.hash)) found = e;
    return found;
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// What History search looks at: only what this machine shared with the hub.
const archiveText = (x) => [x.agent.name, x.agent.title, x.agent.project, x.agent.branch, x.agent.model,
  ...Object.values(x.events).flat().map((e) => `${e.text ?? ''} ${e.summary ?? ''} ${e.label ?? ''}`)].join('\n').toLowerCase();

const MAX_ARCHIVE = 300;       // ended sessions kept per machine
const STATE_FILE = 'hub-state.json';

export class Hub extends EventEmitter {
  machines = new Map(); // name -> machine

  // dataDir: where the hub keeps its state across restarts (--data-dir), or null to keep it in
  // memory only. retainDays: how long ended sessions and silent machines are kept.
  // levelFor(name): the keys file's current cap for a machine (null if it has no entry), so a
  // lowered entry also lowers what's kept from a machine that isn't reporting right now.
  constructor({ dataDir = null, retainDays = 7, levelFor = null } = {}) {
    super();
    this.levelFor = levelFor;
    this.dataDir = dataDir;
    this.retainMs = Math.max(1, retainDays) * 86400e3;
    this.dirty = false;
  }

  start() {
    if (this.dataDir) this.load();
    setInterval(() => this.sweep(), 5000).unref();
    if (this.dataDir) setInterval(() => { if (this.dirty) this.save(); }, 30e3).unref();
  }

  // Applies one report from an authenticated machine. Returns { status, body } for the response.
  ingest(entry, body, now = Date.now()) {
    if (!isObj(body)) return { status: 400, body: { error: 'Expected a JSON object' } };
    if (body.v !== PROTOCOL) return { status: 400, body: { error: `Unsupported protocol ${body.v}; this hub speaks ${PROTOCOL}. Update agent-hub-ui on both sides.` } };
    const instance = typeof body.instance === 'string' ? body.instance.slice(0, 64) : '';
    if (!instance || !Number.isInteger(body.seq)) return { status: 400, body: { error: 'Missing instance or seq' } };
    const level = minLevel(levelOf(body.share) || 'metadata', entry.share);

    let m = this.machines.get(entry.name);
    if (m && m.instance !== instance && m.online && now - m.lastSeen < DUPLICATE_MS) {
      return { status: 409, body: { error: `Another machine is already reporting as "${entry.name}". Give each machine its own key.` } };
    }
    const fresh = !m || m.instance !== instance;
    // A reporter the hub doesn't know yet (or lost track of) has to start with a full snapshot.
    if ((fresh || body.seq !== m.seq + 1) && !isObj(body.init)) return { status: 200, body: { ok: true, needInit: true } };

    if (fresh) {
      // A restarted reporter (or the hub's own restart) keeps the machine's earlier sessions: those
      // the new snapshot no longer lists move to the archive in setAgents().
      const prev = m;
      m = {
        name: entry.name, instance, connectedAt: now, others: [], share: prev?.share,
        agents: prev?.agents || [], events: prev?.events || new Map(), keys: prev?.keys || new Set(), archive: prev?.archive || new Map(),
      };
      this.machines.set(entry.name, m);
    }
    this.dirty = true;
    // The keys file lowered this machine's level: what the hub already keeps from it, archive
    // included, drops to the new level too.
    if (m.share && level !== m.share && minLevel(level, m.share) === level) this.lowerLevel(m, level);
    const wasOnline = m.online;
    Object.assign(m, {
      seq: body.seq, lastSeen: now, online: true, share: level,
      host: typeof body.host === 'string' ? body.host.slice(0, 100) : '',
      version: typeof body.version === 'string' ? body.version.slice(0, 30) : '',
    });

    let agentsChanged = !wasOnline || fresh;
    if (isObj(body.init)) {
      this.setAgents(m, body.init.agents, level, now); // archives what's gone, with its events
      m.events.clear();
      m.others = this.prefixOthers(m, body.init.others, level);
      for (const [key, evs] of Object.entries(shareAllEvents(body.init.events, level))) this.addEvents(m, key, evs, false);
      agentsChanged = true;
      if (!wasOnline) console.log(`[hub] ${m.name} connected (${level})`);
      this.emit('others');
    } else {
      if (Array.isArray(body.agents)) { this.setAgents(m, body.agents, level, now); agentsChanged = true; }
      if (Array.isArray(body.others)) { m.others = this.prefixOthers(m, body.others, level); this.emit('others'); }
      for (const batch of Array.isArray(body.events) ? body.events.slice(0, 2000) : []) {
        if (isObj(batch) && typeof batch.key === 'string') this.addEvents(m, batch.key, shareEvents(batch.events, level), true);
      }
    }
    if (agentsChanged) this.emit('agents');
    return { status: 200, body: { ok: true, needInit: false } };
  }

  setAgents(m, agents, level, now = Date.now()) {
    const before = m.agents;
    m.agents = shareAgents(agents, level).map((a) => {
      const subagents = a.subagents
        .filter((s) => s.key.startsWith(`${a.key}/`))
        .map((s) => ({ ...s, key: `${m.name}:${s.key}` }));
      return { ...a, key: `${m.name}:${a.key}`, subagents, machine: m.name, remote: true, share: level };
    });
    m.keys = new Set(m.agents.flatMap((a) => [a.key, ...a.subagents.map((s) => s.key)]));
    for (const a of before) if (!m.keys.has(a.key)) this.archiveAgent(m, a, now);
    for (const k of m.events.keys()) if (!m.keys.has(k)) m.events.delete(k);
  }

  lowerLevel(m, level) {
    const again = (a) => {
      const [x] = shareAgents([a], level);
      return x && { ...x, subagents: x.subagents.map((s) => ({ ...s })), machine: m.name, remote: true, share: level };
    };
    m.agents = m.agents.map(again).filter(Boolean);
    for (const [k, evs] of m.events) m.events.set(k, shareEvents(evs, level));
    m.others = shareOthers(m.others, level).map((o) => ({ ...o, machine: m.name }));
    for (const [k, x] of m.archive) {
      const agent = again(x.agent);
      if (!agent) { m.archive.delete(k); continue; }
      m.archive.set(k, { ...x, agent, events: Object.fromEntries(Object.entries(x.events).map(([ek, evs]) => [ek, shareEvents(evs, level)])) });
    }
    m.share = level;
    this.dirty = true;
  }

  // An ended session the reporter no longer lists, kept for the History page.
  archiveAgent(m, a, now = Date.now()) {
    const keys = [a.key, ...a.subagents.map((s) => s.key)];
    const events = Object.fromEntries(keys.filter((k) => m.events.get(k)?.length).map((k) => [k, m.events.get(k)]));
    if (!a.toolCount && !Object.keys(events).length) return; // nothing happened in it
    m.archive.delete(a.key);
    m.archive.set(a.key, {
      agent: { ...a, live: false, status: 'offline', now: { verb: 'Ended', since: a.lastAt || now } },
      events, endedAt: now,
    });
    while (m.archive.size > MAX_ARCHIVE) m.archive.delete(m.archive.keys().next().value);
    this.dirty = true;
  }

  // Ended sessions of every machine, newest first: [{ key, machine, endedAt, agent }].
  history({ q = '', limit = 100 } = {}) {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const m of this.machines.values()) {
      for (const [key, x] of m.archive) {
        if (needle && !archiveText(x).includes(needle)) continue;
        out.push({ key, machine: m.name, endedAt: x.endedAt, agent: x.agent });
      }
    }
    return out.sort((a, b) => b.endedAt - a.endedAt).slice(0, limit);
  }

  archived(key) {
    for (const m of this.machines.values()) if (m.archive.has(key)) return m.archive.get(key);
    return null;
  }

  /* ---------- state across restarts (--data-dir) ---------- */

  save() {
    if (!this.dataDir) return;
    const data = {
      v: 1, savedAt: Date.now(),
      machines: [...this.machines.values()].map((m) => ({
        name: m.name, host: m.host, version: m.version, share: m.share, lastSeen: m.lastSeen, connectedAt: m.connectedAt,
        agents: m.agents, others: m.others, events: [...m.events], archive: [...m.archive],
      })),
    };
    const file = path.join(this.dataDir, STATE_FILE);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      this.dirty = false;
    } catch (e) {
      console.error(`[hub] couldn't save its state to ${file}: ${e.message}`);
    }
  }

  // Everything restored goes through share.js again: the file ends up in the dashboard's HTML.
  load() {
    const file = path.join(this.dataDir, STATE_FILE);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[hub] couldn't read ${file}: ${e.message}`);
      return;
    }
    const now = Date.now();
    for (const s of Array.isArray(data?.machines) ? data.machines : []) {
      if (!isObj(s) || !NAME_RE.test(String(s.name)) || !levelOf(s.share)) continue;
      const level = s.share;
      const prefix = `${s.name}:`;
      const mine = (k) => typeof k === 'string' && k.startsWith(prefix);
      const restore = (list) => shareAgents(Array.isArray(list) ? list : [], level)
        .filter((a) => mine(a.key))
        .map((a) => ({ ...a, subagents: a.subagents.filter((x) => mine(x.key)), machine: s.name, remote: true, share: level }));
      const eventsOf = (pairs) => new Map((Array.isArray(pairs) ? pairs : [])
        .filter((p) => Array.isArray(p) && mine(p[0])).map(([k, evs]) => [k, shareEvents(evs, level).slice(-MAX_EVENTS)]));
      const m = {
        name: s.name, instance: null, seq: -1, online: false, share: level,
        host: String(s.host ?? '').slice(0, 100), version: String(s.version ?? '').slice(0, 30),
        lastSeen: Number(s.lastSeen) || 0, connectedAt: Number(s.connectedAt) || 0,
        agents: restore(s.agents), others: [], events: eventsOf(s.events), archive: new Map(),
      };
      m.keys = new Set(m.agents.flatMap((a) => [a.key, ...a.subagents.map((x) => x.key)]));
      for (const p of Array.isArray(s.archive) ? s.archive.slice(-MAX_ARCHIVE) : []) {
        if (!Array.isArray(p) || !mine(p[0]) || !isObj(p[1])) continue;
        const [agent] = restore([p[1].agent]);
        const endedAt = Number(p[1].endedAt) || 0;
        if (!agent || now - endedAt > this.retainMs) continue;
        m.archive.set(p[0], { agent, endedAt, events: Object.fromEntries([...eventsOf(Object.entries(isObj(p[1].events) ? p[1].events : {}))]) });
      }
      if (now - m.lastSeen < this.retainMs) this.machines.set(m.name, m);
    }
    console.log(`[hub] restored ${this.machines.size} machine${this.machines.size === 1 ? '' : 's'} from ${file}`);
  }

  addEvents(m, key, events, live) {
    const k = `${m.name}:${key}`;
    if (!m.keys.has(k) || !events.length) return;
    const arr = m.events.get(k) || [];
    arr.push(...events);
    if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
    m.events.set(k, arr);
    if (live) this.emit('events', k, events);
  }

  prefixOthers(m, others, level) {
    return shareOthers(others, level).map((o) => ({ ...o, id: `${m.name}:${o.id}`, machine: m.name }));
  }

  sweep(now = Date.now()) {
    let changed = false;
    for (const [name, m] of this.machines) {
      const cap = this.levelFor?.(name);
      if (cap && m.share && minLevel(m.share, cap) !== m.share) { this.lowerLevel(m, cap); changed = true; }
      for (const [k, x] of m.archive) if (now - x.endedAt > this.retainMs) { m.archive.delete(k); this.dirty = true; }
      if (now - m.lastSeen > this.retainMs) { this.machines.delete(name); changed = true; }
      else if (m.agents.length && now - m.lastSeen > FORGET_MS) {
        // Silent for hours: its sessions leave the live view for the archive.
        for (const a of m.agents) this.archiveAgent(m, a, now);
        m.agents = [];
        m.keys = new Set();
        m.events.clear();
        changed = true;
      } else if (m.online && now - m.lastSeen > OFFLINE_MS) {
        m.online = false;
        changed = true;
        console.log(`[hub] ${name} stopped reporting`);
      }
    }
    if (changed) { this.emit('agents'); this.emit('others'); }
  }

  // Agents of every machine; those of a disconnected machine are shown as ended.
  snapshot() {
    return [...this.machines.values()].flatMap((m) => (m.online ? m.agents : m.agents.map((a) => ({
      ...a,
      live: false,
      status: 'offline',
      now: { verb: 'Disconnected', since: m.lastSeen },
      subagents: a.subagents.map((s) => (s.status === 'working' ? { ...s, status: 'idle' } : s)),
    }))));
  }

  others() {
    return [...this.machines.values()].filter((m) => m.online).flatMap((m) => m.others);
  }

  allEvents(limit) {
    const out = {};
    for (const m of this.machines.values()) for (const [k, evs] of m.events) out[k] = evs.slice(-limit);
    return out;
  }

  list() {
    return [...this.machines.values()].map((m) => ({
      id: m.name, name: m.name, host: m.host, version: m.version, share: m.share, online: m.online,
      outdated: versionBelow(m.version, MIN_REPORTER),
      lastSeen: m.lastSeen, connectedAt: m.connectedAt, live: m.agents.filter((a) => a.live).length,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
