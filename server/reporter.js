// Reports this machine's agents to a hub (see hub.js). Opt-in with --report-to; nothing leaves the
// machine otherwise. Every ~second it POSTs what changed, filtered to the chosen sharing level
// (share.js): a full snapshot first, and again whenever the hub or the connection lost track.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PROTOCOL } from './hub.js';
import { levelOf, shareAgents, shareAllEvents, shareEvents, shareOthers } from './share.js';

const FLUSH_MS = 1000;
const HEARTBEAT_MS = 5000;     // the hub marks a machine disconnected after 20s of silence
const MAX_PENDING = 5000;      // events buffered while the hub is unreachable; beyond that, resend a snapshot
const TIMEOUT_MS = 15000;

const isLoopback = (host) => host === 'localhost' || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host === '::1';

// Checks the hub URL up front so a typo or an unencrypted link fails at startup.
export function ingestUrl(to, allowHttp = false) {
  let u;
  try { u = new URL(to); } catch { throw new Error(`--report-to: not a URL: ${to}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('--report-to must be an http(s):// URL');
  if (u.protocol === 'http:' && !isLoopback(u.hostname) && !allowHttp) {
    throw new Error(`Refusing to send transcripts over plain http to ${u.host}. Use https://, or --allow-http if the network is already encrypted (VPN, Tailscale, WireGuard).`);
  }
  if (u.username || u.password) throw new Error('--report-to must not contain credentials; pass the key with --report-key-file or $AGENT_HUB_REPORT_KEY');
  return new URL('ingest', u.href.endsWith('/') ? u.href : `${u.href}/`);
}

export class Reporter extends EventEmitter {
  constructor({ url, key, share, collector, procs, version }) {
    super();
    if (!levelOf(share)) throw new Error(`--share must be metadata, activity or full (got "${share}")`);
    if (!key) throw new Error('A machine key is required: --report-key-file <file> or $AGENT_HUB_REPORT_KEY');
    Object.assign(this, { url, key, share, collector, procs, version });
    this.instance = crypto.randomUUID();
    this.seq = 0;
    this.needInit = true;
    this.pending = [];
    this.pendingCount = 0;
    this.sentAgents = '';
    this.sentOthers = '';
    this.sentAt = 0;
    this.retryAt = 0;
    this.failures = 0;
    this.busy = false;
    this.status = { to: url.origin, share, state: 'connecting', error: '', since: Date.now() };
  }

  start() {
    this.collector.on('events', (key, events) => {
      if (this.needInit) return; // the next snapshot carries them
      const shared = shareEvents(events, this.share);
      if (!shared.length) return;
      this.pending.push({ key, events: shared });
      this.pendingCount += shared.length;
      if (this.pendingCount > MAX_PENDING) this.resync();
    });
    console.log(`Reporting this machine's agents to ${this.url.origin} (sharing: ${this.share})`);
    setInterval(() => this.flush(), FLUSH_MS).unref?.();
    this.flush();
  }

  resync() {
    this.needInit = true;
    this.pending = [];
    this.pendingCount = 0;
  }

  setStatus(state, error = '') {
    if (state === this.status.state && error === this.status.error) return;
    if (state === 'ok') console.log(`[report] connected to ${this.url.origin}`);
    else if (state === 'error') console.error(`[report] ${error}`);
    this.status = { ...this.status, state, error, since: Date.now() };
    this.emit('status', this.status);
  }

  body() {
    const b = { v: PROTOCOL, instance: this.instance, seq: this.seq + 1, share: this.share, host: os.hostname(), version: this.version };
    const agents = JSON.stringify(shareAgents(this.collector.snapshot(), this.share));
    const others = JSON.stringify(shareOthers(this.procs.others, this.share));
    if (this.needInit) {
      b.init = { agents: JSON.parse(agents), others: JSON.parse(others), events: shareAllEvents(this.collector.allEvents(200), this.share) };
    } else {
      if (agents !== this.sentAgents) b.agents = JSON.parse(agents);
      if (others !== this.sentOthers) b.others = JSON.parse(others);
      if (this.pending.length) b.events = this.pending;
      if (!b.agents && !b.others && !b.events && Date.now() - this.sentAt < HEARTBEAT_MS) return null;
    }
    return { b, agents, others };
  }

  async flush() {
    if (this.busy || Date.now() < this.retryAt) return;
    const next = this.body();
    if (!next) return;
    const { b, agents, others } = next;
    this.pending = [];
    this.pendingCount = 0;
    this.needInit = false;
    this.busy = true;
    try {
      const res = await this.post(b);
      if (res.status === 200) {
        this.seq = b.seq;
        this.sentAt = Date.now();
        this.sentAgents = agents;
        this.sentOthers = others;
        this.failures = 0;
        if (res.body?.needInit) this.resync();
        this.setStatus('ok');
        return;
      }
      const why = res.body?.error || `HTTP ${res.status}`;
      if (res.status === 401) this.fail(`The hub rejected this machine's key (${why})`, 60e3);
      else if (res.status === 409) this.fail(why, 15e3);
      else this.fail(`The hub refused the report: ${why}`);
    } catch (e) {
      this.fail(`Hub unreachable at ${this.url.origin}: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  fail(message, wait) {
    this.resync();
    this.failures++;
    this.retryAt = Date.now() + (wait ?? Math.min(60e3, 1000 * 2 ** Math.min(this.failures, 6)));
    this.setStatus('error', message);
  }

  post(body) {
    const data = zlib.gzipSync(JSON.stringify(body));
    const lib = this.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(this.url, {
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': data.length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, body: parsed });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
}
