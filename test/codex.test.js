import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCollector, CodexTranscript, headLine } from '../server/codex.js';
import { shareAgents, shareEvents } from '../server/share.js';

// Synthetic records with the field names Codex writes (codex-rs protocol.rs / models.rs).
const ROOT = '019ac5e2-0000-7000-8000-00000000a001';
const CHILD = '019ac5e2-0000-7000-8000-00000000b002';
const REVIEW = '019ac5e2-0000-7000-8000-00000000c003';
const at = (s) => `2026-11-27T09:15:${String(s).padStart(2, '0')}.000Z`;
const line = (s, type, payload, ordinal) => ({ timestamp: at(s), ...(ordinal != null && { ordinal }), type, payload });

const meta = (id, extra = {}) => line(0, 'session_meta', {
  id, session_id: id, timestamp: at(0), cwd: '/home/dev/acme', originator: 'codex_cli_rs', cli_version: '0.120.0',
  source: 'cli', model_provider: 'openai', base_instructions: { text: 'You are Codex…' }, history_mode: 'paginated',
  git: { commit_hash: '3f2a9c1e', branch: 'main' }, ...extra,
}, 0);

const turn = [
  line(1, 'event_msg', { type: 'task_started', turn_id: 't1', model_context_window: 272000 }, 1),
  line(1, 'turn_context', { turn_id: 't1', cwd: '/home/dev/acme', model: 'gpt-5.5-codex', effort: 'medium' }, 2),
  line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] }, 3),
  line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing sum test' }] }, 4),
  line(1, 'event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix the failing sum test', text_elements: [] }] } }, 5),
  line(2, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'secret plan' }], encrypted_content: 'xyz' }, 6),
  line(3, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: '/home/dev/acme' }), call_id: 'call_A1' }, 7),
  line(5, 'response_item', { type: 'function_call_output', call_id: 'call_A1', output: 'Chunk ID: 4f1e\nWall time: 2.3 seconds\nProcess exited with code 1\nOriginal token count: 9\nOutput:\nFAIL test/sum.test.js\n' }, 8),
  line(6, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'call_B2', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/sum.js\n@@\n-  return a - b;\n+  return a + b;\n*** End Patch\n' }, 9),
  line(6, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_B2', output: 'Exit code: 0\nWall time: 0.01 seconds\nOutput:\nSuccess. Updated the following files:\nM src/sum.js\n' }, 10),
  line(7, 'response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Fix sum', status: 'completed' }, { step: 'Run tests', status: 'in_progress' }] }), call_id: 'call_C3' }, 11),
  line(7, 'response_item', { type: 'function_call_output', call_id: 'call_C3', output: 'Plan updated' }, 12),
  line(8, 'response_item', { type: 'function_call', name: 'list_issues', namespace: 'mcp__github__', arguments: '{"repo":"acme/app"}', call_id: 'call_D4' }, 13),
];
const done = [
  line(9, 'response_item', { type: 'function_call_output', call_id: 'call_D4', output: [{ type: 'input_text', text: '[]' }] }, 14),
  line(10, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the sign in sum(); tests pass.' }], phase: 'final_answer' }, 15),
  line(10, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 48210, output_tokens: 1830, total_tokens: 50040 }, last_token_usage: { input_tokens: 16100, output_tokens: 420, total_tokens: 16520 }, model_context_window: 272000 } }, 16),
  line(11, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'Fixed the sign in sum(); tests pass.' }, 17),
];

const ingestAll = (tr, records) => records.flatMap((r) => tr.ingest(r));

test('turns a Codex rollout into prompt, tool, result and say events', () => {
  const tr = new CodexTranscript();
  const evs = ingestAll(tr, [meta(ROOT), ...turn, ...done]);

  const prompts = evs.filter((e) => e.kind === 'prompt');
  assert.deepEqual(prompts.map((e) => e.text), ['fix the failing sum test'], 'one prompt, injected context skipped');

  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.cat, e.summary]), [
    ['exec_command', 'run', 'npm test'],
    ['apply_patch', 'edit', 'sum.js'],
    ['update_plan', 'plan', '2 steps'],
    ['mcp__github__list_issues', 'mcp', 'acme/app'],
  ]);
  assert.equal(tools[3].label, 'github · list_issues');
  assert.equal(tools[3].freeText, true, 'the summary is free text from the arguments');
  assert.equal(shareEvents([tools[3]], 'activity')[0].summary, undefined, 'so a hub below full does not get it');
  assert.equal(shareEvents([tools[3]], 'full')[0].summary, 'acme/app');
  assert.equal(tools[0].freeText, undefined);

  const results = new Map(evs.filter((e) => e.kind === 'result').map((e) => [e.toolId, e]));
  assert.equal(results.get('call_A1').ok, false, 'exit code 1 is a failure');
  assert.equal(results.get('call_A1').text, 'FAIL test/sum.test.js', 'exec header stripped');
  assert.equal(results.get('call_A1').ms, 2000);
  assert.equal(results.get('call_B2').ok, true);
  assert.equal(results.get('call_D4').text, '[]');

  assert.deepEqual(evs.filter((e) => e.kind === 'say').map((e) => e.text), ['Fixed the sign in sum(); tests pass.']);
  assert.ok(!JSON.stringify(evs).includes('secret plan'), 'reasoning summaries are never shown');
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, 'event ids are unique');

  assert.equal(tr.model, 'gpt-5.5-codex');
  assert.equal(tr.branch, 'main');
  assert.equal(tr.outTokens, 1830);
  assert.equal(tr.context, 16520);
  assert.equal(tr.toolCount, 4);
  assert.deepEqual(tr.todos, [{ content: 'Fix sum', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }]);
  assert.equal(tr.turn, null, 'task_complete closes the turn');
  assert.equal(tr.pending.size, 0);
});

test('reads prompts from user_message in legacy rollouts and notes interruptions', () => {
  const tr = new CodexTranscript();
  const evs = ingestAll(tr, [
    line(1, 'event_msg', { type: 'task_started', turn_id: 't1' }),
    line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    line(1, 'event_msg', { type: 'user_message', message: 'hello' }),
    line(2, 'event_msg', { type: 'agent_message', message: 'hi' }),
    line(2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
    line(3, 'event_msg', { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' }),
  ]);
  assert.deepEqual(evs.map((e) => [e.kind, e.text]), [['prompt', 'hello'], ['say', 'hi'], ['note', 'Interrupted by user']]);
  assert.equal(tr.turn, null);
});

test('headLine reads a long first line from the start of the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-'));
  const f = path.join(dir, 'x.jsonl');
  const big = meta(ROOT, { base_instructions: { text: 'x'.repeat(200 * 1024) } });
  fs.writeFileSync(f, JSON.stringify(big) + '\n' + JSON.stringify(turn[0]) + '\n');
  assert.equal(headLine(f).payload.id, ROOT);
  fs.writeFileSync(f, '{"type":"session_meta"');
  assert.equal(headLine(f), null, 'no complete line yet');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collector finds live sessions, their status, names and subagents', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-'));
  const day = path.join(home, 'sessions', '2026', '11', '27');
  const locks = path.join(home, 'thread-writer-locks');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(locks);
  const file = (id) => path.join(day, `rollout-2026-11-27T09-15-02-${id}.jsonl`);
  const write = (id, records) => fs.writeFileSync(file(id), records.map((r) => JSON.stringify(r) + '\n').join(''));
  const append = (id, records) => fs.appendFileSync(file(id), records.map((r) => JSON.stringify(r) + '\n').join(''));

  write(ROOT, [meta(ROOT), ...turn]);
  write(CHILD, [
    meta(CHILD, { session_id: ROOT, parent_thread_id: ROOT, thread_source: 'subagent', agent_role: 'explorer', agent_nickname: 'Ada',
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1 } } } }),
    line(1, 'event_msg', { type: 'task_started', turn_id: 'c1' }, 1),
  ]);
  write(REVIEW, [meta(REVIEW, { source: { subagent: 'review' } })]);
  for (const id of [ROOT, CHILD, REVIEW]) fs.writeFileSync(path.join(locks, `${id}.lock`), '');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ id: ROOT, thread_name: 'old', updated_at: at(0) })}\n${JSON.stringify({ id: ROOT, thread_name: 'Sum fix', updated_at: at(5) })}\n`);

  const dir = { root: home, sessions: path.join(home, 'sessions'), locks, index: path.join(home, 'session_index.jsonl') };
  const c = new CodexCollector({ running: () => true, dir });
  const events = new Map();
  c.on('events', (key, evs) => events.set(key, [...(events.get(key) || []), ...evs]));
  c.scanRecent();
  c.tick();

  let snap = c.snapshot();
  assert.equal(snap.length, 1, 'the internal review thread and the subagent are not top-level agents');
  let a = snap[0];
  assert.equal(a.key, `codex:${ROOT}`);
  assert.equal(a.kind, 'codex');
  assert.equal(a.name, 'Sum fix', 'the last session_index entry names it');
  assert.equal(a.project, 'acme');
  assert.equal(a.live, true);
  assert.equal(a.status, 'working');
  assert.equal(a.now.verb, 'Calling', 'the MCP call is still running');
  assert.equal(a.version, '0.120.0');
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].key, `codex:${ROOT}/${CHILD}`);
  assert.equal(a.subagents[0].type, 'explorer');
  assert.equal(a.subagents[0].status, 'working');
  assert.ok(events.get(`codex:${ROOT}`).some((e) => e.kind === 'tool' && e.name === 'exec_command'));
  assert.ok(!c.allEvents(200)[`codex:${REVIEW}`]);
  for (const level of ['metadata', 'activity']) {
    assert.ok(!JSON.stringify(shareAgents(snap, level)).includes('failing sum'), `no prompt text at ${level}`);
  }
  const unnamed = new CodexCollector({ running: () => true, dir: { ...dir, index: path.join(home, 'none.jsonl') } });
  unnamed.scanRecent();
  const [u] = unnamed.snapshot();
  assert.equal(u.name, 'fix the failing sum test', 'without a name the first prompt names it here…');
  assert.equal(u.title, '');
  assert.equal(shareAgents([u], 'activity')[0].name, 'acme', '…but not on a hub below full');
  assert.equal(shareAgents([u], 'full')[0].name, 'fix the failing sum test');

  append(ROOT, done);
  c.tick();
  a = c.snapshot()[0];
  assert.equal(a.status, 'idle', 'a finished turn waits for the user');
  assert.equal(a.now.verb, 'Your turn');
  assert.equal(a.lastSay.text, 'Fixed the sign in sum(); tests pass.');
  assert.ok(c.hasLive());

  fs.rmSync(path.join(locks, `${ROOT}.lock`));
  c.tick();
  c.tick();
  snap = c.snapshot();
  assert.equal(snap[0].live, false, 'no writer lock: the session ended');
  assert.equal(snap[0].status, 'offline');

  // A lock left behind by a crash, with no Codex process and no recent writes, isn't a live session.
  const stale = new CodexCollector({ running: () => false, dir });
  const old = (Date.now() - 600e3) / 1000;
  fs.utimesSync(file(CHILD), old, old);
  stale.scanRecent();
  stale.tick();
  assert.equal(stale.threads.get(CHILD).live, false);
  fs.rmSync(home, { recursive: true, force: true });
});
