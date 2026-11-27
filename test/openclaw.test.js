import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { OpenClawCollector, OpenClawTranscript } from '../server/openclaw.js';
import { shareAgents } from '../server/share.js';

// Synthetic entries with the field names OpenClaw writes (pi session format: packages/agent-core,
// packages/llm-core; the same JSON as a JSONL line or a transcript_events row).
const at = (s) => new Date(Date.now() - 120e3 + s * 1000).toISOString();
const msg = (s, id, message) => ({ type: 'message', id, parentId: null, timestamp: at(s), message });
const usage = (input, output, total) => ({ input, output, cacheRead: 1000, cacheWrite: 0, totalTokens: input + output + 1000, cost: { total } });

const entries = [
  { type: 'session', version: 4, id: 's1', timestamp: at(0), cwd: '/home/dev/.openclaw/workspace' },
  { type: 'model_change', id: 'e0', parentId: null, timestamp: at(0), provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
  msg(1, 'e1', { role: 'user', content: [{ type: 'text', text: 'injected context' }], synthetic: true, timestamp: 1 }),
  msg(1, 'e2', { role: 'user', content: [{ type: 'text', text: 'Check the README and run the tests' }], timestamp: 1 }),
  msg(2, 'e3', { role: 'assistant', stopReason: 'toolUse', model: 'claude-sonnet-5-5', usage: usage(1200, 40, 0.01), content: [
    { type: 'thinking', thinking: 'PRIVATE THOUGHTS', thinkingSignature: 'sig' },
    { type: 'text', text: 'Checking.' },
    { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'docs/README.md' } },
    { type: 'toolCall', id: 'call_2', name: 'exec', arguments: { command: 'npm test', env: { API_TOKEN: 'sk-SECRET' } } },
    { type: 'toolCall', id: 'call_3', name: 'github__list_issues', arguments: { repo: 'acme/app' } },
  ] }),
  msg(3, 'e4', { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: '# Demo' }], isError: false }),
  msg(5, 'e5', { role: 'toolResult', toolCallId: 'call_2', toolName: 'exec', content: [{ type: 'text', text: '1 failing' }], isError: true }),
];
const final = [
  msg(6, 'e6', { role: 'toolResult', toolCallId: 'call_3', toolName: 'github__list_issues', content: [{ type: 'text', text: '[]' }], isError: false }),
  msg(7, 'e7', { role: 'assistant', stopReason: 'stop', model: 'claude-sonnet-5-5', usage: usage(30, 12, 0.002), content: [{ type: 'text', text: 'One test fails in sum.js.' }] }),
  { type: 'session_info', id: 'e8', parentId: 'e7', timestamp: at(8), name: 'README check' },
];

test('turns OpenClaw transcript entries into events, without thinking or secrets', () => {
  const tr = new OpenClawTranscript();
  const evs = [...entries, ...final].flatMap((e) => tr.ingest(e));
  assert.deepEqual(evs.filter((e) => e.kind === 'prompt').map((e) => e.text), ['Check the README and run the tests']);
  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.cat, e.summary]), [
    ['read', 'read', 'README.md'], ['exec', 'run', 'npm test'], ['mcp__github__list_issues', 'mcp', ''],
  ]);
  assert.equal(tools[2].label, 'github · list_issues');
  const results = new Map(evs.filter((e) => e.kind === 'result').map((e) => [e.toolId, e]));
  assert.equal(results.get('call_1').ok, true);
  assert.equal(results.get('call_2').ok, false);
  assert.equal(results.get('call_2').ms, 3000);
  const all = JSON.stringify(evs);
  assert.ok(!all.includes('PRIVATE THOUGHTS'), 'thinking is never shown');
  assert.ok(!all.includes('sk-SECRET') && !all.includes('API_TOKEN'), 'exec env never leaves the collector');
  assert.ok(!all.includes('injected context'), 'synthetic user entries are skipped');
  assert.deepEqual(evs.filter((e) => e.kind === 'say').map((e) => e.text), ['Checking.', 'One test fails in sum.js.']);
  assert.equal(tr.outTokens, 52);
  assert.equal(tr.context, 1030);
  assert.ok(Math.abs(tr.cost - 0.012) < 1e-9);
  assert.equal(tr.model, 'claude-sonnet-5-5');
  assert.equal(tr.name, 'README check');
  assert.equal(tr.busy, false, 'stopReason stop ends the run');
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.ingest(final[1]).length, 0, 'an entry seen twice is ignored');
});

function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-openclaw-'));
  const lockDir = path.join(dir, 'tmp', 'openclaw-1000');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'gateway.state.lock'), '{}'); // fresh heartbeat: the gateway is up
  return dir;
}
const lines = (recs) => recs.map((r) => JSON.stringify(r) + '\n').join('');

test('legacy layout: sessions.json and JSONL transcripts', async () => {
  const dir = stateDir();
  const sessions = path.join(dir, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sessions, 'sessions.json'), JSON.stringify({
    'agent:main:telegram:direct:+15550001': { sessionId: 'aaaa-1', updatedAt: now, sessionFile: '/somewhere/else/../aaaa-1.jsonl' },
    'agent:main:subagent:bbbb': { sessionId: 'bbbb-2', updatedAt: now, parentSessionKey: 'agent:main:telegram:direct:+15550001', subagentRole: 'researcher', label: 'Find docs' },
    'agent:main:old': { sessionId: 'cccc-3', updatedAt: now - 24 * 3600e3 },
  }));
  fs.writeFileSync(path.join(sessions, 'aaaa-1.jsonl'), lines(entries));
  fs.writeFileSync(path.join(sessions, 'bbbb-2.jsonl'), lines([{ type: 'session', version: 4, id: 'bbbb-2', timestamp: at(0), cwd: '/w' },
    msg(4, 'k1', { role: 'user', content: 'Find the docs' })]));

  const c = new OpenClawCollector({ dir });
  const seen = new Map();
  c.on('events', (k, evs) => seen.set(k, [...(seen.get(k) || []), ...evs]));
  await c.tick();
  let [a, ...rest] = c.snapshot();
  assert.equal(rest.length, 0, 'the subagent hangs under its parent, the old session is not shown');
  assert.equal(a.key, 'openclaw:aaaa-1', 'keys use the session id, not the chat session key');
  assert.equal(a.kind, 'openclaw');
  assert.equal(a.live, true);
  assert.equal(a.status, 'working', 'a tool call is still running');
  assert.equal(a.now.verb, 'Calling');
  assert.equal(a.name, 'Check the README and run the tests');
  assert.equal(a.nameFromPrompt, true);
  assert.equal(shareAgents([a], 'activity')[0].name, 'workspace', 'a prompt-made name stays here below full');
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].key, 'openclaw:aaaa-1/bbbb-2');
  assert.equal(a.subagents[0].type, 'researcher');
  assert.ok(seen.get('openclaw:aaaa-1').some((e) => e.kind === 'tool' && e.name === 'exec'));
  for (const level of ['metadata', 'activity', 'full']) {
    assert.ok(!JSON.stringify(shareAgents(c.snapshot(), level)).includes('15550001'), `no chat id at ${level}`);
  }
  assert.ok(!Object.keys(c.allEvents(200)).some((k) => k.includes('15550001')));

  fs.appendFileSync(path.join(sessions, 'aaaa-1.jsonl'), lines(final));
  await c.tick();
  [a] = c.snapshot();
  assert.equal(a.status, 'idle');
  assert.equal(a.name, 'README check', 'session_info names it here…');
  assert.equal(a.nameFromPrompt, true, '…but it comes from the conversation, so not on a hub below full');
  assert.equal(a.title, '');
  assert.ok(a.cost > 0.0119);

  fs.rmSync(path.join(dir, 'tmp'), { recursive: true });
  await c.tick();
  assert.equal(c.snapshot()[0].status, 'offline', 'no gateway heartbeat: offline');
  fs.rmSync(dir, { recursive: true, force: true });
});

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node without node:sqlite */ }

test('current layout: the per-agent SQLite database, read without touching it', { skip: !sqlite && 'node:sqlite not available' }, async () => {
  const dir = stateDir();
  const agentDir = path.join(dir, 'agents', 'main', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'openclaw-agent.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, status TEXT, created_at INTEGER, parent_session_key TEXT, spawned_by TEXT, label TEXT,
      display_name TEXT, archived_at INTEGER, last_activity_at INTEGER);
    CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL,
      event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY (session_id, seq));`);
  const now = Date.now();
  const node = db.prepare('INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, last_activity_at, parent_session_key, label, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  node.run('agent:main:main', 'win-1', JSON.stringify({ sessionId: 'win-1', updatedAt: now }), now, now, null, 'Home assistant', null);
  node.run('agent:main:archived', 'win-9', '{}', now, now, null, null, now);
  const ev = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes) VALUES (?, ?, ?, ?, ?, ?)');
  const zstd = typeof zlib.zstdCompressSync === 'function';
  [...entries, ...final].forEach((e, i) => {
    const json = JSON.stringify(e);
    // Large rows are stored compressed.
    if (zstd && e.id === 'e3') ev.run('win-1', i, null, now, zlib.zstdCompressSync(Buffer.from(json)), Buffer.byteLength(json));
    else ev.run('win-1', i, json, now, null, null);
  });
  db.close();
  const before = fs.readdirSync(agentDir).sort();
  const mtime = fs.statSync(file).mtimeMs;

  const c = new OpenClawCollector({ dir });
  await c.tick();
  const snap = c.snapshot();
  assert.equal(snap.length, 1, 'archived sessions are skipped');
  const [a] = snap;
  assert.equal(a.key, 'openclaw:win-1');
  assert.equal(a.name, 'Home assistant');
  assert.equal(a.nameFromPrompt, false, 'a label the user set can be shared');
  assert.equal(a.status, 'idle');
  assert.equal(a.toolCount, zstd ? 3 : 0, 'the compressed row holds the tool calls');
  assert.equal(a.lastSay.text, 'One test fails in sum.js.');
  assert.deepEqual(fs.readdirSync(agentDir).sort(), before, 'no -wal/-shm files were created');
  assert.equal(fs.statSync(file).mtimeMs, mtime);

  // New rows are picked up incrementally.
  const w = new sqlite.DatabaseSync(file);
  w.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run('win-1', 50, JSON.stringify(msg(9, 'e9', { role: 'user', content: 'and fix it' })), now);
  w.prepare('UPDATE session_nodes SET updated_at = ? WHERE session_key = ?').run(now + 1, 'agent:main:main');
  w.close();
  await c.tick();
  assert.equal(c.snapshot()[0].status, 'working');
  assert.equal(c.snapshot()[0].lastPrompt, 'and fix it');

  // While the gateway has the database open in WAL mode, it's read alongside the writer.
  const gw = new sqlite.DatabaseSync(file);
  gw.exec('PRAGMA journal_mode=WAL');
  gw.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run('win-1', 51, JSON.stringify(msg(10, 'e10', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Fixed.' }] })), now);
  await c.tick();
  assert.equal(c.snapshot()[0].lastSay.text, 'Fixed.');
  assert.equal(c.snapshot()[0].status, 'idle');
  gw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
