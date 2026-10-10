// Hub mode: keeps the agents that other machines report (see reporter.js) next to this PC's own.
// Each machine authenticates with its own key; the hub names the machine from the key, never
// from what the reporter says about itself, and prefixes its agent keys with that name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { levelOf, minLevel, shareAgents, shareAllEvents, shareEvents, shareOthers } from './share.js';

export const PROTOCOL = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const OFFLINE_MS = 20e3;       // a machine silent this long is shown as disconnected…
const FORGET_MS = 3 * 3600e3;  // …and is dropped this long after its last report
const DUPLICATE_MS = 15e3;     // another reporter on the same key is refused while the first is active
const MAX_EVENTS = 200;        // per agent key, like the snapshot a browser gets on connect

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

export class Hub extends EventEmitter {
  machines = new Map(); // name -> machine

  start() {
    setInterval(() => this.sweep(), 5000).unref();
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
      m = { name: entry.name, instance, agents: [], others: [], events: new Map(), keys: new Set(), connectedAt: now };
      this.machines.set(entry.name, m);
    }
    const wasOnline = m.online;
    Object.assign(m, {
      seq: body.seq, lastSeen: now, online: true, share: level,
      host: typeof body.host === 'string' ? body.host.slice(0, 100) : '',
      version: typeof body.version === 'string' ? body.version.slice(0, 30) : '',
    });

    let agentsChanged = !wasOnline || fresh;
    if (isObj(body.init)) {
      m.events.clear();
      this.setAgents(m, body.init.agents, level);
      m.others = this.prefixOthers(m, body.init.others, level);
      for (const [key, evs] of Object.entries(shareAllEvents(body.init.events, level))) this.addEvents(m, key, evs, false);
      agentsChanged = true;
      if (!wasOnline) console.log(`[hub] ${m.name} connected (${level})`);
      this.emit('others');
    } else {
      if (Array.isArray(body.agents)) { this.setAgents(m, body.agents, level); agentsChanged = true; }
      if (Array.isArray(body.others)) { m.others = this.prefixOthers(m, body.others, level); this.emit('others'); }
      for (const batch of Array.isArray(body.events) ? body.events.slice(0, 2000) : []) {
        if (isObj(batch) && typeof batch.key === 'string') this.addEvents(m, batch.key, shareEvents(batch.events, level), true);
      }
    }
    if (agentsChanged) this.emit('agents');
    return { status: 200, body: { ok: true, needInit: false } };
  }

  setAgents(m, agents, level) {
    m.agents = shareAgents(agents, level).map((a) => {
      const subagents = a.subagents
        .filter((s) => s.key.startsWith(`${a.key}/`))
        .map((s) => ({ ...s, key: `${m.name}:${s.key}` }));
      return { ...a, key: `${m.name}:${a.key}`, subagents, machine: m.name, remote: true, share: level };
    });
    m.keys = new Set(m.agents.flatMap((a) => [a.key, ...a.subagents.map((s) => s.key)]));
    for (const k of m.events.keys()) if (!m.keys.has(k)) m.events.delete(k);
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
      if (now - m.lastSeen > FORGET_MS) { this.machines.delete(name); changed = true; }
      else if (m.online && now - m.lastSeen > OFFLINE_MS) {
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
      lastSeen: m.lastSeen, connectedAt: m.connectedAt, live: m.agents.filter((a) => a.live).length,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
