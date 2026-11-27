import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeCollector, OpenCodeTranscript, opencodeCategory, v1Message, v2Message } from '../server/opencode.js';
import { shareAgents, shareEvents } from '../server/share.js';

// Synthetic rows with the columns and JSON opencode writes: 2.x tables session_v2 / session_message /
// session_part (packages/core/src/session/sql.ts, packages/schema/src/session-message.ts) and 1.x
// tables session / message / part (packages/schema/src/v1/session.ts).
const T0 = Date.now() - 120e3;
const at = (s) => T0 + s * 1000;
const tokens = (input, output) => ({ input, output, reasoning: 5, cache: { read: 1000, write: 0 } });

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node without node:sqlite */ }
const skip = !sqlite && 'node:sqlite not available';

function v2Db(dir) {
  const db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_busy INTEGER, time_idle INTEGER,
      idle_outcome TEXT, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL,
      call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (message_id, ordinal));`);
  return db;
}
const session = (db, s) => db.prepare(`INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, cost,
    tokens_output, agent, model, time_created, time_updated, time_busy, time_idle)
  VALUES (?, 'prj', ?, 'slug', ?, ?, '2.4.2', ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(s.id, s.parent ?? null, s.dir, s.title ?? null, s.cost ?? 0, s.out ?? 0, s.agent ?? null,
    JSON.stringify({ id: 'claude-sonnet-5-5', providerID: 'anthropic' }), at(0), s.updated ?? at(1), s.busy ?? null, s.idle ?? null);
const message = (db, sid, seq, id, type, data, t = at(seq)) => db.prepare(`INSERT OR REPLACE INTO session_message
  (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sid, type, seq, t, t, JSON.stringify(data));
const part = (db, sid, mid, ordinal, data, t) => db.prepare(`INSERT OR REPLACE INTO session_part
  (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(mid, sid, ordinal, data.type, data.type === 'tool' ? data.id : null, t, t, JSON.stringify(data));
const tool = (id, name, input, state, time) => ({ type: 'tool', id, name, state: { input, ...state }, time });

test('2.x rows become events: prompt, tools, text, never reasoning or secrets', () => {
  const tr = new OpenCodeTranscript();
  const evs = [];
  const user = { id: 'msg_1', type: 'user', seq: 1, time_created: at(1), time_updated: at(1), data: JSON.stringify({ text: 'Fix the failing test', time: { created: at(1) } }) };
  evs.push(...tr.ingest(v2Message(user)));
  const asst = (data) => ({ id: 'msg_2', type: 'assistant', seq: 2, time_created: at(2), time_updated: at(5), data: JSON.stringify({ agent: 'build', model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' }, content: [], ...data }) });
  const parts = (states) => [
    { ordinal: 0, type: 'reasoning', time_updated: at(2), data: JSON.stringify({ type: 'reasoning', text: 'PRIVATE THOUGHTS', time: { created: at(2), completed: at(2) } }) },
    { ordinal: 1, type: 'text', time_updated: at(2), data: JSON.stringify({ type: 'text', text: 'Looking at it.' }) },
    { ordinal: 2, type: 'tool', time_updated: at(3), data: JSON.stringify(tool('call_1', 'read', { path: 'src/sum.js' }, states[0], { created: at(3), completed: states[0].status === 'completed' ? at(4) : undefined })) },
    { ordinal: 3, type: 'tool', time_updated: at(3), data: JSON.stringify(tool('call_2', 'shell', { command: 'npm test', env: { API_TOKEN: 'sk-SECRET' } }, states[1], { created: at(3), ran: at(3), completed: states[1].status === 'error' ? at(6) : undefined })) },
    { ordinal: 4, type: 'tool', time_updated: at(3), data: JSON.stringify(tool('call_3', 'github_list_issues', { repo: 'acme/app' }, states[2], { created: at(3) })) },
  ];
  // Streaming: the call's input is still partial JSON, so no tool event yet.
  evs.push(...tr.ingest(v2Message(asst({ time: { created: at(2) } }), parts([
    { status: 'running', metadata: {} }, { status: 'streaming', input: '{"comm' }, { status: 'running', metadata: {} }]))));
  assert.deepEqual(evs.filter((e) => e.kind === 'tool').map((e) => e.name), ['read', 'mcp__github__list_issues']);
  assert.equal(tr.pending.size, 2);
  assert.equal(tr.busy, true);
  // Completed and failed: each tool event once, a result once.
  const done = parts([
    { status: 'completed', content: [{ type: 'text', text: 'export const sum = …' }] },
    { status: 'error', error: { type: 'tool.execution', message: '1 failing' }, metadata: { exit: 1 } },
    { status: 'completed', content: [{ type: 'text', text: '[]' }] }]);
  const finished = asst({ time: { created: at(2), completed: at(7) }, finish: 'tool-calls', tokens: tokens(1200, 40), cost: 0.01 });
  evs.push(...tr.ingest(v2Message(finished, done)));
  assert.equal(tr.ingest(v2Message(finished, done)).length, 0, 'a message read again adds nothing');

  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.cat, e.summary]), [
    ['read', 'read', 'sum.js'], ['mcp__github__list_issues', 'mcp', 'acme/app'], ['shell', 'run', 'npm test'],
  ]);
  assert.equal(tools[1].label, 'github · list_issues');
  assert.equal(tools[1].freeText, true, 'the summary is free text from the arguments');
  assert.equal(shareEvents([tools[1]], 'activity')[0].summary, undefined, 'so a hub below full does not get it');
  assert.equal(tools[0].freeText, undefined);
  const results = new Map(evs.filter((e) => e.kind === 'result').map((e) => [e.toolId, e]));
  assert.equal(results.size, 3);
  assert.equal(results.get('call_1').ok, true);
  assert.equal(results.get('call_1').ms, 1000);
  assert.equal(results.get('call_2').ok, false);
  assert.equal(results.get('call_2').ms, 3000);
  assert.match(results.get('call_2').text, /1 failing/);
  assert.deepEqual(evs.filter((e) => e.kind === 'prompt').map((e) => e.text), ['Fix the failing test']);
  assert.deepEqual(evs.filter((e) => e.kind === 'say').map((e) => e.text), ['Looking at it.']);
  const all = JSON.stringify(evs);
  assert.ok(!all.includes('PRIVATE THOUGHTS'), 'reasoning is never shown');
  assert.ok(!all.includes('sk-SECRET') && !all.includes('API_TOKEN'), 'secret-looking arguments never leave the collector');
  assert.equal(tr.outTokens, 40);
  assert.equal(tr.context, 2200);
  assert.ok(Math.abs(tr.cost - 0.01) < 1e-9);
  assert.equal(tr.model, 'claude-sonnet-5-5');
  assert.equal(tr.busy, true, 'finish tool-calls: the turn goes on');
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, 'event ids are unique');

  tr.ingest(v2Message({ id: 'msg_3', type: 'idle', seq: 3, time_created: at(8), time_updated: at(8), data: JSON.stringify({ outcome: 'succeeded', time: { created: at(8) } }) }));
  assert.equal(tr.busy, false);
  assert.equal(tr.pending.size, 0);
});

test('tool categories', () => {
  assert.deepEqual(['read', 'glob', 'edit', 'patch', 'shell', 'bash', 'webfetch', 'subagent', 'task', 'todowrite', 'question', 'opencode_session_rename', 'automation_create', 'context7_resolve-library-id'].map(opencodeCategory),
    ['read', 'read', 'edit', 'edit', 'run', 'run', 'web', 'agent', 'agent', 'plan', 'ask', 'other', 'plan', 'mcp']);
});

test('2.x database: status, subagents, todos and sharing, read without touching it', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-'));
  let db = v2Db(dir);
  const cwd = process.platform === 'win32' ? 'C:/work/demo-app' : '/work/demo-app';
  session(db, { id: 'ses_parent', dir: cwd, title: 'Fix the failing sum test', busy: at(1), out: 52, cost: 0.012 });
  session(db, { id: 'ses_child', parent: 'ses_parent', dir: cwd, title: 'Find callers', agent: 'explore', busy: at(4) });
  session(db, { id: 'ses_old', dir: cwd, updated: Date.now() - 24 * 3600e3 });
  message(db, 'ses_parent', 1, 'msg_p1', 'user', { text: 'Please fix the failing sum test', time: { created: at(1) } });
  message(db, 'ses_parent', 2, 'msg_p2', 'assistant', { agent: 'build', model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' }, content: [], time: { created: at(2) } });
  part(db, 'ses_parent', 'msg_p2', 0, tool('call_t', 'todowrite', { todos: [{ content: 'Run tests', status: 'in_progress' }, { content: 'Fix sum', status: 'pending' }] },
    { status: 'completed', content: [{ type: 'text', text: 'ok' }] }, { created: at(2), completed: at(2) }), at(2));
  part(db, 'ses_parent', 'msg_p2', 1, tool('call_s', 'subagent', { agent: 'explore', description: 'Find callers', prompt: 'Find every caller of sum()' },
    { status: 'running', metadata: {} }, { created: at(3) }), at(3));
  message(db, 'ses_child', 1, 'msg_c1', 'user', { text: 'Find every caller of sum()', time: { created: at(4) } });
  message(db, 'ses_child', 2, 'msg_c2', 'assistant', { agent: 'explore', model: { id: 'claude-haiku-5', providerID: 'anthropic' }, content: [
    tool('call_g', 'grep', { pattern: 'sum(' }, { status: 'running', metadata: {} }, { created: at(5) })], time: { created: at(5) } }); // an inline (pre-part-rows) message
  db.close();
  const before = fs.readdirSync(dir).sort();

  const c = new OpenCodeCollector({ dir, running: () => true });
  const seen = new Map();
  c.on('events', (k, evs) => seen.set(k, [...(seen.get(k) || []), ...evs]));
  await c.tick();
  let [a, ...rest] = c.snapshot();
  assert.equal(rest.length, 0, 'the child hangs under its parent, the old session is not shown');
  assert.equal(a.key, 'opencode:ses_parent');
  assert.equal(a.kind, 'opencode');
  assert.equal(a.live, true);
  assert.equal(a.status, 'working');
  assert.equal(a.now.verb, 'Delegating');
  assert.equal(a.cwd, process.platform === 'win32' ? 'C:\\work\\demo-app' : '/work/demo-app');
  assert.equal(a.project, 'demo-app');
  assert.equal(a.model, 'claude-sonnet-5-5');
  assert.equal(a.version, '2.4.2');
  assert.equal(a.outTokens, 52, 'totals come from the session row');
  assert.equal(a.cost, 0.012);
  assert.equal(a.name, 'Fix the failing sum test');
  assert.equal(a.nameFromPrompt, true, 'opencode titles sessions from the prompt');
  assert.equal(a.title, '');
  assert.deepEqual(a.todos, [{ content: 'Run tests', status: 'in_progress' }, { content: 'Fix sum', status: 'pending' }]);
  assert.equal(a.subagents.length, 1);
  const sub = a.subagents[0];
  assert.equal(sub.key, 'opencode:ses_parent/ses_child');
  assert.equal(sub.type, 'explore');
  assert.equal(sub.description, 'Find callers');
  assert.equal(sub.status, 'working');
  assert.equal(sub.model, 'claude-haiku-5');
  assert.ok(seen.get('opencode:ses_parent/ses_child').some((e) => e.kind === 'tool' && e.name === 'grep'), 'child events use the parent/child key');
  assert.ok(seen.get('opencode:ses_parent').some((e) => e.kind === 'tool' && e.name === 'subagent' && e.summary === 'Find callers · explore'));

  const shared = JSON.stringify(shareAgents(c.snapshot(), 'activity'));
  for (const text of ['Please fix', 'Find every caller', 'Fix the failing sum test']) assert.ok(!shared.includes(text), `no "${text}" at activity`);
  assert.equal(shareAgents(c.snapshot(), 'activity')[0].name, 'demo-app');
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no -wal/-shm or other file was created');

  // The question tool waits for the user.
  db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  part(db, 'ses_parent', 'msg_p2', 1, tool('call_s', 'subagent', { agent: 'explore', description: 'Find callers', prompt: 'Find every caller of sum()' },
    { status: 'completed', content: [{ type: 'text', text: 'Two callers.' }] }, { created: at(3), completed: at(9) }), at(9));
  part(db, 'ses_parent', 'msg_p2', 2, tool('call_q', 'question', { questions: [{ question: 'Change the API?' }] }, { status: 'running', metadata: {} }, { created: at(10) }), at(10));
  db.prepare('UPDATE session_v2 SET time_idle = ?, time_updated = ? WHERE id = ?').run(at(9), at(9), 'ses_child');
  db.close();
  await c.tick();
  [a] = c.snapshot();
  assert.equal(a.status, 'waiting');
  assert.equal(a.subagents[0].status, 'done');
  const results = seen.get('opencode:ses_parent').filter((e) => e.kind === 'result');
  assert.deepEqual(results.map((e) => e.toolId), ['call_t', 'call_s'], 'one result per tool, when it finishes');
  assert.equal(results[1].ms, 6000);

  // The step ends and the turn goes idle.
  db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  part(db, 'ses_parent', 'msg_p2', 2, tool('call_q', 'question', { questions: [{ question: 'Change the API?' }] },
    { status: 'completed', content: [{ type: 'text', text: 'yes' }] }, { created: at(10), completed: at(11) }), at(11));
  part(db, 'ses_parent', 'msg_p2', 3, { type: 'text', text: 'Fixed sum.js; tests pass.' }, at(12));
  message(db, 'ses_parent', 2, 'msg_p2', 'assistant', { agent: 'build', model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' }, content: [],
    finish: 'stop', tokens: tokens(300, 12), cost: 0.002, time: { created: at(2), completed: at(12) } }, at(12));
  message(db, 'ses_parent', 3, 'msg_p3', 'idle', { outcome: 'succeeded', time: { created: at(13) } }, at(13));
  db.prepare('UPDATE session_v2 SET time_idle = ?, idle_outcome = ? WHERE id = ?').run(at(13), 'succeeded', 'ses_parent');
  db.close();
  await c.tick();
  [a] = c.snapshot();
  assert.equal(a.status, 'idle');
  assert.equal(a.now.verb, 'Your turn');
  assert.equal(a.lastSay.text, 'Fixed sum.js; tests pass.');
  const evs = seen.get('opencode:ses_parent');
  assert.equal(evs.filter((e) => e.kind === 'tool').length, 3, 'each tool event only once');
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length);
  assert.equal(c.allEvents(200)['opencode:ses_parent'].length, evs.length);

  c.running = () => false; // no opencode process and no fresh -wal: ended
  await c.tick();
  assert.equal(c.snapshot()[0].status, 'offline');
  assert.equal(c.hasLive(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('more than ten recent sessions: the newest ten, each read once', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-'));
  let db = v2Db(dir);
  for (let i = 0; i < 12; i++) {
    session(db, { id: `ses_${String(i).padStart(2, '0')}`, dir: '/work/many', updated: at(i) });
    message(db, `ses_${String(i).padStart(2, '0')}`, 1, `msg_${i}`, 'user', { text: `prompt ${i}`, time: { created: at(i) } });
  }
  db.close();
  const c = new OpenCodeCollector({ dir, running: () => true });
  const keys = [];
  c.on('events', (k) => keys.push(k));
  await c.tick();
  assert.equal(c.snapshot().length, 10);
  assert.ok(!c.snapshot().some((a) => a.sessionId === 'ses_00' || a.sessionId === 'ses_01'), 'the two oldest are left out');
  db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  message(db, 'ses_11', 2, 'msg_11b', 'user', { text: 'another prompt', time: { created: at(20) } });
  db.close();
  await c.tick();
  assert.equal(keys.length, 11, 'ten first reads, then only the session that changed');
  assert.equal(keys.at(-1), 'opencode:ses_11');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('1.x database: session, message and part tables', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-'));
  const db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.prepare("INSERT INTO session VALUES ('ses_v1', 'prj', NULL, 'slug', '/work/legacy', 'Rename the helper', '1.19.6', ?, ?, NULL)").run(at(0), at(9));
  const msg = (id, t, data) => db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, 'ses_v1', t, t, JSON.stringify(data));
  const prt = (id, mid, t, data) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(id, mid, 'ses_v1', t, t, JSON.stringify(data));
  const assistant = { role: 'assistant', parentID: 'msg_a', modelID: 'gpt-5.5', providerID: 'openai', mode: 'build', agent: 'build',
    path: { cwd: '/work/legacy', root: '/work/legacy' } };
  msg('msg_a', at(1), { role: 'user', time: { created: at(1) }, agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' } });
  prt('prt_a1', 'msg_a', at(1), { type: 'text', text: 'Rename the helper to add' });
  prt('prt_a2', 'msg_a', at(1), { type: 'text', text: 'Called the Read tool with …', synthetic: true });
  msg('msg_b', at(2), { ...assistant, time: { created: at(2), completed: at(4) }, finish: 'tool-calls', cost: 0.003, tokens: tokens(800, 20) });
  prt('prt_b1', 'msg_b', at(2), { type: 'reasoning', text: 'PRIVATE THOUGHTS', time: { start: at(2), end: at(2) } });
  prt('prt_b2', 'msg_b', at(3), { type: 'tool', callID: 'call_e', tool: 'edit', state: { status: 'completed', input: { filePath: '/work/legacy/src/util.js', oldString: 'sum', newString: 'add' },
    output: 'Edit applied', title: 'src/util.js', metadata: {}, time: { start: at(3), end: at(4) } } });
  msg('msg_c', at(5), { ...assistant, time: { created: at(5), completed: at(6) }, finish: 'stop', cost: 0.001, tokens: tokens(900, 8) });
  prt('prt_c1', 'msg_c', at(6), { type: 'text', text: 'Renamed it.', time: { start: at(5), end: at(6) } });
  db.close();

  const c = new OpenCodeCollector({ dir, running: () => true });
  const seen = [];
  c.on('events', (k, evs) => seen.push(...evs.map((e) => ({ k, ...e }))));
  await c.tick();
  const [a] = c.snapshot();
  assert.equal(a.key, 'opencode:ses_v1');
  assert.equal(a.status, 'idle');
  assert.equal(a.cwd, '/work/legacy');
  assert.equal(a.model, 'gpt-5.5');
  assert.equal(a.outTokens, 28, 'summed from the messages when the row has no totals');
  assert.ok(Math.abs(a.cost - 0.004) < 1e-9);
  assert.deepEqual(seen.map((e) => e.kind), ['prompt', 'tool', 'result', 'say']);
  assert.equal(seen[0].text, 'Rename the helper to add', 'synthetic text parts are skipped');
  assert.equal(seen[1].summary, 'util.js');
  assert.equal(seen[2].ms, 1000);
  assert.ok(!JSON.stringify(seen).includes('PRIVATE THOUGHTS'));
  assert.equal(v1Message({ id: 'm', time_created: 1, time_updated: 1, data: '{"role":"user"}' }).hasParts, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
