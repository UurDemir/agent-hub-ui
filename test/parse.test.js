import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tail, Transcript, activity, toolCategory, toolLabel, clip, costRates, transcriptCost } from '../server/parse.js';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:00:02.500Z';

const assistant = (content, extra = {}) => ({
  type: 'assistant', uuid: 'a1', timestamp: T0,
  message: { id: 'msg_1', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 }, ...extra },
});
const user = (content, extra = {}) => ({ type: 'user', uuid: 'u1', timestamp: T1, message: { content }, ...extra });

test('clip shortens long strings with an ellipsis', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
  assert.equal(clip(null, 4), '');
});

test('toolCategory and toolLabel handle built-in and MCP tools', () => {
  assert.equal(toolCategory('Read'), 'read');
  assert.equal(toolCategory('PowerShell'), 'run');
  assert.equal(toolCategory('SomeNewTool'), 'other');
  assert.equal(toolCategory('ToolSearch'), 'read');
  assert.equal(toolCategory('SubagentHandback'), 'agent');
  assert.equal(toolCategory('StructuredOutput'), 'plan');
  assert.equal(toolCategory('mcp__github__create_pr'), 'mcp');
  assert.equal(toolLabel('Bash'), 'Bash');
  assert.equal(toolLabel('mcp__plugin_playwright_playwright__browser_click'), 'playwright · browser_click');
});

test('a tool call and its result become linked events with a duration', () => {
  const tr = new Transcript();
  const [tool] = tr.ingest(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }]));
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.cat, 'run');
  assert.equal(tool.summary, 'Run tests');
  assert.equal(tr.pending.size, 1);
  assert.equal(activity(tr, 'working').verb, 'Running');

  const [result] = tr.ingest(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }]));
  assert.deepEqual([result.kind, result.toolId, result.ok, result.text, result.ms], ['result', 't1', true, 'ok', 2500]);
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.toolCount, 1);
});

test('usage: output tokens are counted once per message id, context is the latest total', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'thinking', thinking: '' }]));
  tr.ingest(assistant([{ type: 'text', text: 'hello' }]));
  assert.equal(tr.outTokens, 7);
  assert.equal(tr.context, 100);
  assert.equal(tr.model, 'claude-opus-5-5');
  assert.equal(tr.lastSay.text, 'hello');
});

test('usage keeps the largest counts per message, so streamed snapshots are not undercounted', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'text', text: 'a' }], { usage: { input_tokens: 10, output_tokens: 3 } }));
  tr.ingest(assistant([{ type: 'text', text: 'b' }], { usage: { input_tokens: 10, output_tokens: 40 } }));
  assert.equal(tr.outTokens, 40);
  assert.equal(tr.usage.size, 1);
});

test('cost: rates come from cost-state records and price each transcript by model', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'text', text: 'hi' }], { id: 'm1', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
  assert.equal(transcriptCost(tr, {}), null);

  tr.ingest({ type: 'cost-state', totalCostUSD: 2, modelUsage: {
    'claude-opus-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 2 },
  } });
  const rates = costRates([tr.costState]);
  // The transcript used exactly the tokens the cost record priced, so it costs the same.
  assert.ok(Math.abs(transcriptCost(tr, rates) - 2) < 1e-9);
});

test('TodoWrite updates the plan', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Write tests', status: 'in_progress' }] } }]));
  assert.deepEqual(tr.todos, [{ content: 'Write tests', status: 'in_progress' }]);
});

test('prompts: real text is kept, injected context is skipped, slash commands are formatted', () => {
  const tr = new Transcript();
  assert.deepEqual(tr.ingest(user('fix the bug')).map((e) => [e.kind, e.text]), [['prompt', 'fix the bug']]);
  assert.equal(tr.ingest(user('<system-reminder>x</system-reminder>')).length, 0);
  assert.equal(tr.ingest(user('meta', { isMeta: true })).length, 0);
  const [cmd] = tr.ingest(user('<command-name>/init</command-name><command-args>now</command-args>'));
  assert.equal(cmd.text, '/init now');
});

test('an interruption clears pending tools and marks the turn done', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/a/b.js' } }]));
  const [note] = tr.ingest(user('[Request interrupted by user]'));
  assert.equal(note.kind, 'note');
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.phase.kind, 'done');
});

test('an API error reply becomes a note and ends the turn', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/a.js' } }]));
  const [note] = tr.ingest({
    type: 'assistant', uuid: 'e1', timestamp: T1, isApiErrorMessage: true, apiErrorStatus: 429,
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: rate limited' }] },
  });
  assert.deepEqual([note.kind, note.text], ['note', 'API Error: rate limited']);
  assert.equal(tr.phase.kind, 'done');
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.model, 'claude-opus-5-5');
  assert.equal(tr.lastSay, null);
});

test('turn_duration marks the turn done; compaction summaries are not shown as prompts', () => {
  const tr = new Transcript();
  tr.ingest(assistant([{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'ls' } }]));
  tr.ingest({ type: 'system', subtype: 'turn_duration', durationMs: 900, timestamp: T1 });
  assert.equal(tr.phase.kind, 'done');
  assert.equal(tr.pending.size, 0);
  assert.equal(tr.ingest(user('This session is being continued…', { isCompactSummary: true, isVisibleInTranscriptOnly: true })).length, 0);
});

test('hand-back and structured output tools get readable summaries', () => {
  const tr = new Transcript();
  const [a] = tr.ingest(assistant([{ type: 'tool_use', id: 't6', name: 'SubagentHandback', input: { message: 'long report…' } }]));
  const [b] = tr.ingest(assistant([{ type: 'tool_use', id: 't7', name: 'StructuredOutput', input: { findings: [] } }]));
  assert.equal(a.summary, 'Final report');
  assert.equal(b.summary, 'Structured result');
  assert.equal(tr.handedBack, true);
});

test('metadata records set title, agent name, branch and PR links', () => {
  const tr = new Transcript();
  tr.ingest({ type: 'ai-title', aiTitle: 'Fix login' });
  tr.ingest({ type: 'agent-name', agentName: 'worker-1' });
  tr.ingest({ type: 'user', gitBranch: 'feature/x', cwd: '/repo', timestamp: T0, message: { content: 'go' } });
  const [pr] = tr.ingest({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5, prRepository: 'o/r' });
  tr.ingest({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5 });
  assert.equal(tr.title, 'Fix login');
  assert.equal(tr.agentName, 'worker-1');
  assert.equal(tr.branch, 'feature/x');
  assert.equal(tr.cwd, '/repo');
  assert.equal(pr.kind, 'pr');
  assert.equal(tr.prs.length, 1);
});

test('Tail returns only complete lines and resets when the file shrinks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
  const tail = new Tail(file, 1024 * 1024);

  assert.deepEqual(tail.read(), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(file, '{"a":');
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(file, '3}\nnot json\n');
  assert.deepEqual(tail.read(), [{ a: 3 }]);
  fs.writeFileSync(file, '{"b":1}\n');
  assert.deepEqual(tail.read(), [{ b: 1 }]);
});

test('Tail started mid-file drops the partial first line', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '{"first":"xxxxxxxxxx"}\n{"b":2}\n');
  assert.deepEqual(new Tail(file, 12).read(), [{ b: 2 }]);
});

test('messages delivered through the messaging socket become prompts with a sender', () => {
  const tr = new Transcript();
  const queued = (origin) => ({
    type: 'attachment', uuid: 'q1', timestamp: T0,
    attachment: { type: 'queued_command', prompt: ' run the tests ', commandMode: 'prompt', origin, isMeta: true },
  });
  const [e] = tr.ingest(queued({ kind: 'peer', from: 'agent-hub' }));
  assert.equal(e.kind, 'prompt');
  assert.equal(e.from, 'agent-hub');
  assert.equal(e.text, 'run the tests');
  assert.deepEqual(tr.ingest(queued({ kind: 'user' })), []);
  assert.deepEqual(tr.ingest({ type: 'attachment', timestamp: T0, attachment: { type: 'other' } }), []);
});
