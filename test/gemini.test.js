import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiCollector, GeminiTranscript, geminiToolName } from '../server/gemini.js';
import { shareAgents, shareEvents } from '../server/share.js';

// Synthetic records with the field names Gemini CLI writes (packages/core/src/services/
// chatRecordingTypes.ts: a metadata line, MessageRecords re-appended whole when they change,
// { $set } metadata updates; tool calls carry status scheduled -> success / error / cancelled).
const SID = '7d1c2e3f-0000-4000-8000-00000000a001';
const AGENT = '9a8b7c6d-0000-4000-8000-00000000b002';
const T0 = Math.floor(Date.now() / 1000) * 1000 - 60e3; // recent, so the collector counts the chats as live
const at = (s) => new Date(T0 + s * 1000).toISOString();

const header = (extra = {}) => ({ sessionId: SID, projectHash: 'acme', startTime: at(0), lastUpdated: at(0), kind: 'main', ...extra });
const user = (id, s, content, extra = {}) => ({ id, timestamp: at(s), type: 'user', content, ...extra });
const gemini = (id, s, content, extra = {}) => ({ id, timestamp: at(s), type: 'gemini', content, model: 'gemini-3-pro', ...extra });
const thoughts = [{ subject: 'Planning', description: 'private chain of thought', timestamp: at(2) }];
const tokens = { input: 12000, output: 40, cached: 8000, thoughts: 25, tool: 0, total: 12065 };
const readCall = (status, s, extra = {}) => ({ id: 'read_file_1', name: 'read_file', args: { file_path: '/home/dev/acme/src/sum.js' }, status, timestamp: at(s), ...extra });
const shellCall = (status, s, extra = {}) => ({ id: 'run_shell_command_2', name: 'run_shell_command', args: { command: 'npm test', dir_path: '/home/dev/acme' }, status, timestamp: at(s), ...extra });
const fr = (id, name, response) => ({ functionResponse: { id, name, response } });

const turn = [
  header(),
  user('u1', 1, [{ text: 'fix the failing sum test' }]),
  { $set: { lastUpdated: at(1) } },
  gemini('g1', 3, 'Let me look at the code.', { thoughts, tokens }),
  gemini('g1', 3, 'Let me look at the code.', { thoughts, tokens, toolCalls: [readCall('scheduled', 3), shellCall('scheduled', 3)] }),
  gemini('g1', 3, 'Let me look at the code.', { thoughts, tokens, toolCalls: [
    readCall('success', 4, { result: [fr('read_file_1', 'read_file', { output: 'export const sum = (a, b) => a - b;' })] }),
    shellCall('error', 6, { result: [fr('run_shell_command_2', 'run_shell_command', { error: 'Exit code: 1' })], resultDisplay: 'Exit code: 1' }),
  ] }),
  user('u2', 6, [fr('read_file_1', 'read_file', { output: '…' }), fr('run_shell_command_2', 'run_shell_command', { error: 'Exit code: 1' })]),
  gemini('g2', 8, '', { tokens: { ...tokens, output: 15, thoughts: 0 }, toolCalls: [
    { id: 'mcp_1', name: 'mcp_github_list_issues', args: { repo: 'acme/app', api_key: 'sk-secret' }, status: 'scheduled', timestamp: at(8) },
  ] }),
];
const done = [
  gemini('g2', 8, '', { tokens: { ...tokens, output: 15, thoughts: 0 }, toolCalls: [
    { id: 'mcp_1', name: 'mcp_github_list_issues', args: { repo: 'acme/app', api_key: 'sk-secret' }, status: 'success', timestamp: at(9), result: [fr('mcp_1', 'mcp_github_list_issues', { output: '[]' })] },
  ] }),
  user('u3', 9, [fr('mcp_1', 'mcp_github_list_issues', { output: '[]' })]),
  gemini('g3', 10, [{ text: 'thinking about it', thought: true }, { text: 'Fixed the sign in sum(); tests pass.' }], { thoughts, tokens: { ...tokens, output: 30, thoughts: 10 } }),
];

const ingestAll = (tr, records) => records.flatMap((r) => tr.ingest(r));

test('turns a Gemini chat into prompt, tool, result and say events', () => {
  const tr = new GeminiTranscript();
  const evs = ingestAll(tr, turn);

  assert.deepEqual(evs.filter((e) => e.kind === 'prompt').map((e) => e.text), ['fix the failing sum test'], 'tool responses are not prompts');
  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.cat, e.summary]), [
    ['read_file', 'read', 'sum.js'],
    ['run_shell_command', 'run', 'npm test'],
    ['mcp__github__list_issues', 'mcp', 'acme/app'],
  ], 'each tool call once, although its message was appended three times');
  assert.equal(tools[2].label, 'github · list_issues');
  assert.equal(tools[2].freeText, true, 'an MCP summary is free text from the arguments');
  assert.equal(shareEvents([tools[2]], 'activity')[0].summary, undefined, 'so a hub below full does not get it');
  assert.equal(tools[0].freeText, undefined);
  assert.ok(!JSON.stringify(evs).includes('sk-secret'), 'secret-looking arguments never reach a summary or detail');

  const results = new Map(evs.filter((e) => e.kind === 'result').map((e) => [e.toolId, e]));
  assert.equal(results.size, 2);
  assert.equal(results.get('read_file_1').ok, true);
  assert.equal(results.get('read_file_1').text, 'export const sum = (a, b) => a - b;');
  assert.equal(results.get('read_file_1').ms, 1000);
  assert.equal(results.get('run_shell_command_2').ok, false, 'status error is a failure');
  assert.equal(results.get('run_shell_command_2').text, 'Exit code: 1');
  assert.equal(results.get('run_shell_command_2').ms, 3000);

  assert.equal(tr.turn, true, 'the MCP call is still running');
  assert.deepEqual([...tr.pending.keys()], ['mcp_1']);

  const more = ingestAll(tr, done);
  const all = [...evs, ...more];
  assert.deepEqual(all.filter((e) => e.kind === 'say').map((e) => e.text), ['Let me look at the code.', 'Fixed the sign in sum(); tests pass.']);
  assert.equal(more.filter((e) => e.kind === 'result').length, 1);
  for (const secret of ['private chain of thought', 'thinking about it']) {
    assert.ok(!JSON.stringify(all).includes(secret), 'thoughts are never shown');
    assert.ok(!JSON.stringify(tr.lastSay).includes(secret));
  }
  assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'event ids are unique');

  assert.equal(tr.model, 'gemini-3-pro');
  assert.equal(tr.outTokens, 65 + 15 + 40, 'output + thoughts, counted once per message');
  assert.equal(tr.context, 12000 + 30, 'the last reply: prompt + output');
  assert.equal(tr.toolCount, 3);
  assert.equal(tr.turn, false, 'a reply with no tool calls ends the turn');
  assert.equal(tr.pending.size, 0);
});

test('maps Gemini tool names, todos, questions and cancelled calls', () => {
  assert.equal(geminiToolName('mcp_slack_post_message'), 'mcp__slack__post_message');
  assert.equal(geminiToolName('github__list_issues'), 'mcp__github__list_issues', 'older <server>__<tool> names');
  assert.equal(geminiToolName('glob'), 'glob');

  const tr = new GeminiTranscript();
  const evs = ingestAll(tr, [
    user('u1', 1, [{ text: 'plan it' }]),
    gemini('g1', 2, '', { toolCalls: [
      { id: 't1', name: 'write_todos', args: { todos: [{ description: 'Fix sum', status: 'completed' }, { description: 'Run tests', status: 'in_progress' }, { description: 'Old idea', status: 'cancelled' }] }, status: 'success', timestamp: at(2), result: [] },
      { id: 't2', name: 'ask_user', args: { questions: [{ question: 'Which branch?' }] }, status: 'scheduled', timestamp: at(2) },
    ] }),
  ]);
  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.cat, e.summary]), [['plan', '3 todos'], ['ask', '']]);
  assert.deepEqual(tr.todos, [{ content: 'Fix sum', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }]);
  assert.equal([...tr.pending.values()].at(-1).name, 'ask_user');

  ingestAll(tr, [gemini('g1', 3, '', { toolCalls: [{ id: 't2', name: 'ask_user', args: {}, status: 'cancelled', timestamp: at(3), result: [fr('t2', 'ask_user', { error: 'cancelled' })] }] })]);
  assert.equal(tr.turn, false, 'a cancelled call ends the turn');
});

test('a legacy JSON file read again keeps its state and emits nothing twice', () => {
  const tr = new GeminiTranscript();
  const rec = { sessionId: SID, projectHash: 'acme', startTime: at(0), lastUpdated: at(3), messages: [
    user('u1', 1, [{ text: 'first' }]),
    gemini('g1', 2, 'Done with that.'),
    user('u2', 3, [{ text: 'which branch?' }]),
    gemini('g2', 4, '', { toolCalls: [{ id: 'q1', name: 'ask_user', args: { questions: [] }, status: 'scheduled', timestamp: at(4) }] }),
  ] };
  const first = tr.ingestRecord(rec);
  assert.deepEqual(first.map((e) => e.kind), ['prompt', 'say', 'prompt', 'tool']);
  assert.deepEqual(tr.ingestRecord({ ...rec, lastUpdated: at(5) }), [], 'nothing new');
  assert.equal(tr.turn, true);
  assert.deepEqual([...tr.pending.keys()], ['q1'], 'the open question survives the re-read');
});

test('collector shows live chats with status, project, subagents and legacy JSON files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-'));
  const project = path.join(home, 'acme');
  const tmp = path.join(home, '.gemini', 'tmp');
  const chats = path.join(tmp, 'acme', 'chats');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(chats, SID), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'acme', '.project_root'), project);
  const file = path.join(chats, 'session-2026-11-27T09-15-7d1c2e3f.jsonl');
  const lines = (records) => records.map((r) => JSON.stringify(r) + '\n').join('');
  fs.writeFileSync(file, lines(turn));
  fs.writeFileSync(path.join(chats, SID, `${AGENT}.jsonl`), lines([
    { sessionId: AGENT, projectHash: 'acme', startTime: at(4), lastUpdated: at(4), kind: 'subagent' },
    user('s1', 4, [{ text: 'investigate the sum module' }]),
    gemini('s2', 5, '', { toolCalls: [{ id: 'grep_1', name: 'grep_search', args: { pattern: 'sum', dir_path: '/home/dev/acme/src' }, status: 'scheduled', timestamp: at(5) }] }),
  ]));
  // An older Gemini CLI wrote the whole conversation as one JSON file.
  const OLD = '5e5e5e5e-0000-4000-8000-00000000c003';
  fs.writeFileSync(path.join(chats, 'session-2026-11-27T08-00-5e5e5e5e.json'), JSON.stringify({
    sessionId: OLD, projectHash: 'acme', startTime: at(-30), lastUpdated: at(-20),
    messages: [user('o1', -30, [{ text: 'old question' }]), gemini('o2', -20, 'old answer', { tokens })],
  }));

  const dir = { root: path.join(home, '.gemini'), tmp, registry: path.join(home, '.gemini', 'projects.json') };
  let up = true;
  const c = new GeminiCollector({ running: () => up, dir });
  const events = new Map();
  c.on('events', (key, evs) => events.set(key, [...(events.get(key) || []), ...evs]));
  c.scanRecent();
  c.tick();

  const snap = c.snapshot();
  assert.equal(snap.length, 2);
  const a = snap.find((x) => x.sessionId === SID);
  assert.equal(a.key, `gemini:${SID}`);
  assert.ok(!a.key.slice(7).includes('/') && !a.key.slice(7).includes(':'), 'a top-level key has no "/"');
  assert.equal(a.kind, 'gemini');
  assert.equal(a.project, 'acme');
  assert.equal(a.cwd, fs.realpathSync.native(project));
  assert.equal(a.live, true);
  assert.equal(a.status, 'working');
  assert.equal(a.now.verb, 'Calling', 'the MCP call is still running');
  assert.equal(a.name, 'fix the failing sum test');
  assert.equal(a.nameFromPrompt, true);
  assert.equal(a.title, '');
  assert.equal(a.model, 'gemini-3-pro');
  assert.equal(a.toolCount, 3);
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].key, `gemini:${SID}/${AGENT}`);
  assert.equal(a.subagents[0].status, 'working');
  assert.equal(a.subagents[0].now.verb, 'Reading');
  assert.deepEqual(events.get(`gemini:${SID}`).filter((e) => e.kind === 'tool').map((e) => e.toolId), ['read_file_1', 'run_shell_command_2', 'mcp_1']);
  assert.equal(events.get(`gemini:${SID}/${AGENT}`)[0].text, 'investigate the sum module');

  const old = snap.find((x) => x.sessionId === OLD);
  assert.equal(old.key, `gemini:${OLD}`);
  assert.equal(old.status, 'idle', 'its last reply ended the turn');
  assert.equal(old.outTokens, 65);
  assert.deepEqual(c.allEvents(50)[`gemini:${OLD}`].map((e) => e.kind), ['prompt', 'say']);

  // At the activity level the hub gets neither prompts nor a name made from one.
  const shared = JSON.stringify(shareAgents(snap, 'activity'));
  for (const text of ['fix the failing sum test', 'old question', 'investigate the sum module', 'acme/app']) {
    assert.ok(!shared.includes(text), `"${text}" is not shared at the activity level`);
  }
  assert.equal(shareAgents(snap, 'activity').find((x) => x.sessionId === SID).name, 'acme');

  // The reply arrives: the turn is over.
  fs.appendFileSync(file, lines(done));
  c.tick();
  const b = c.snapshot().find((x) => x.sessionId === SID);
  assert.equal(b.status, 'idle');
  assert.equal(b.now.verb, 'Your turn');
  assert.equal(b.lastSay.text, 'Fixed the sign in sum(); tests pass.');

  // Gemini exits: the chats end once they are no longer fresh.
  up = false;
  c.setLive();
  assert.equal(c.hasLive(), true, 'a chat written in the last two minutes still counts as live');
  for (const s of c.sessions.values()) s.tr.lastAt = Date.now() - 10 * 60e3;
  c.setLive();
  assert.equal(c.hasLive(), false);
  assert.equal(c.snapshot().find((x) => x.sessionId === SID).status, 'offline');

  fs.rmSync(home, { recursive: true, force: true });
});
