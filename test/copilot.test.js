import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopilotCollector, CopilotTranscript, yamlScalars } from '../server/copilot.js';
import { shareAgents, shareEvents } from '../server/share.js';

// Synthetic events with the envelope and field names Copilot CLI writes to events.jsonl
// (schemas/session-events.schema.json in the @github/copilot package).
const SID = '3b0c6c55-0000-4000-8000-00000000a001';
const at = (s) => `2026-11-27T09:15:${String(s).padStart(2, '0')}.000Z`;
let n = 0;
const ev = (s, type, data, extra = {}) => ({ type, data, id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, timestamp: at(s), parentId: null, ...extra });

const start = ev(0, 'session.start', {
  sessionId: SID, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.116', startTime: at(0), selectedModel: 'claude-sonnet-4.5',
  context: { cwd: '/home/dev/acme', gitRoot: '/home/dev/acme', repository: 'acme/app', hostType: 'github', branch: 'main' },
});
const turn = [
  ev(1, 'user.message', { content: 'fix the failing sum test', transformedContent: '<current_datetime>…</current_datetime>\n\nfix the failing sum test', interactionId: 'i1' }),
  ev(1, 'assistant.turn_start', { turnId: '0', interactionId: 'i1' }),
  ev(2, 'assistant.reasoning', { reasoningId: 'r1', content: 'secret plan' }),
  ev(2, 'assistant.message', {
    messageId: 'm1', content: '', reasoningText: 'secret plan', outputTokens: 120, interactionId: 'i1',
    toolRequests: [
      { toolCallId: 'call_1', name: 'report_intent', arguments: { intent: 'Fixing tests' } },
      { toolCallId: 'call_2', name: 'bash', arguments: { command: 'npm test', description: 'Run tests', mode: 'sync' } },
    ],
  }),
  ev(2, 'tool.execution_start', { toolCallId: 'call_1', toolName: 'report_intent', arguments: { intent: 'Fixing tests' } }),
  ev(2, 'tool.execution_complete', { toolCallId: 'call_1', success: true, result: { content: 'Intent logged' } }),
  ev(3, 'tool.execution_start', { toolCallId: 'call_2', toolName: 'bash', arguments: { command: 'npm test', description: 'Run tests', mode: 'sync' } }),
  ev(5, 'tool.execution_complete', { toolCallId: 'call_2', success: true, shellExecution: { exitCode: 1 }, result: { content: 'FAIL test/sum.test.js\n<exited with exit code 1>' } }),
  ev(5, 'assistant.turn_end', { turnId: '0' }),
  ev(6, 'assistant.turn_start', { turnId: '1', interactionId: 'i1' }),
  ev(6, 'assistant.message', { messageId: 'm2', content: 'The sign is wrong.', outputTokens: 80, toolRequests: [{ toolCallId: 'call_3', name: 'edit', arguments: {} }] }),
  ev(6, 'tool.execution_start', { toolCallId: 'call_3', toolName: 'edit', arguments: { path: '/home/dev/acme/src/sum.js', old_str: 'a - b', new_str: 'a + b' } }),
  ev(7, 'tool.execution_complete', { toolCallId: 'call_3', success: true, result: { content: 'File /home/dev/acme/src/sum.js updated with changes.' } }),
  ev(7, 'tool.execution_start', { toolCallId: 'call_4', toolName: 'view', arguments: { path: '/home/dev/acme/missing.js' } }),
  ev(7, 'tool.execution_complete', { toolCallId: 'call_4', success: false, error: { message: 'Path does not exist', code: 'failure' } }),
  // A subagent's own events are copied into the parent's log.
  ev(8, 'tool.execution_start', { toolCallId: 'sub_1', toolName: 'grep', arguments: { pattern: 'sum' } }, { agentId: 'explore-1' }),
  ev(8, 'tool.execution_start', {
    toolCallId: 'call_5', toolName: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues',
    arguments: { owner: 'acme', repo: 'app', api_token: 'hunter2' },
  }),
];
const done = [
  ev(9, 'tool.execution_complete', { toolCallId: 'call_5', success: true, result: { content: '[]' } }),
  ev(9, 'assistant.turn_end', { turnId: '1' }),
  ev(10, 'assistant.turn_start', { turnId: '2' }),
  ev(10, 'assistant.message', { messageId: 'm3', content: 'Fixed the sign in sum(); tests pass.', toolRequests: [], outputTokens: 30 }),
  ev(11, 'assistant.turn_end', { turnId: '2' }),
];

const ingestAll = (tr, records) => records.flatMap((r) => tr.ingest(r));

test('turns a Copilot CLI event log into prompt, tool, result and say events', () => {
  const tr = new CopilotTranscript();
  const evs = ingestAll(tr, [start, ...turn]);

  assert.deepEqual(evs.filter((e) => e.kind === 'prompt').map((e) => e.text), ['fix the failing sum test'], 'what was typed, not the injected context');

  const tools = evs.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.cat, e.summary]), [
    ['bash', 'run', 'npm test'],
    ['edit', 'edit', 'sum.js'],
    ['view', 'read', 'missing.js'],
    ['mcp__github-mcp-server__list_issues', 'mcp', 'acme'],
  ], 'report_intent is hidden and the subagent grep stays under its task');
  assert.equal(tools[3].label, 'github-mcp-server · list_issues');
  assert.equal(tools[3].freeText, true, 'the summary is free text from the arguments');
  assert.ok(!tools[3].detail.includes('hunter2'), 'secret-looking arguments are dropped');
  assert.equal(shareEvents([tools[3]], 'activity')[0].summary, undefined, 'so a hub below full does not get it');
  assert.equal(tools[0].freeText, undefined);

  const results = new Map(evs.filter((e) => e.kind === 'result').map((e) => [e.toolId, e]));
  assert.ok(!results.has('call_1'));
  assert.equal(results.get('call_2').ok, false, 'exit code 1 is a failure');
  assert.equal(results.get('call_2').ms, 2000);
  assert.equal(results.get('call_3').ok, true);
  assert.equal(results.get('call_4').ok, false);
  assert.equal(results.get('call_4').text, 'Path does not exist');

  assert.equal(tr.busy, true, 'the MCP call is still running');
  assert.equal(tr.pending.size, 1);
  const more = ingestAll(tr, done);
  assert.equal(tr.busy, false, 'a turn that asks for no tools ends the run');
  assert.deepEqual([...evs, ...more].filter((e) => e.kind === 'say').map((e) => e.text), ['The sign is wrong.', 'Fixed the sign in sum(); tests pass.']);
  assert.ok(!JSON.stringify([...evs, ...more]).includes('secret plan'), 'reasoning is never shown');
  assert.equal(new Set([...evs, ...more].map((e) => e.id)).size, evs.length + more.length, 'event ids are unique');

  assert.equal(tr.model, 'claude-sonnet-4.5');
  assert.equal(tr.version, '1.0.116');
  assert.equal(tr.branch, 'main');
  assert.equal(tr.cwd, '/home/dev/acme');
  assert.equal(tr.outTokens, 230);
  assert.equal(tr.toolCount, 4);
});

test('notes aborts and errors, tracks permission prompts and shutdown', () => {
  const tr = new CopilotTranscript();
  ingestAll(tr, [start, ev(1, 'user.message', { content: 'deploy it' }), ev(1, 'assistant.turn_start', { turnId: '0' })]);
  ingestAll(tr, [ev(2, 'permission.requested', { requestId: 'p1', permissionRequest: { kind: 'shell', toolCallId: 'call_9', fullCommandText: 'rm -rf dist' } })]);
  assert.equal(tr.permissions.size, 1);
  ingestAll(tr, [ev(3, 'permission.completed', { requestId: 'p1', result: { kind: 'approved' } })]);
  assert.equal(tr.permissions.size, 0);
  const evs = ingestAll(tr, [
    ev(4, 'abort', { reason: 'user_initiated' }),
    ev(5, 'session.error', { errorType: 'notification', message: 'An extension says hi' }),
    ev(6, 'user.message', { content: 'again' }),
    ev(6, 'session.error', { errorType: 'query', message: 'Execution failed: rate limited' }),
    ev(7, 'session.compaction_complete', { success: true, preCompactionTokens: 90000 }),
  ]);
  assert.deepEqual(evs.filter((e) => e.kind === 'note').map((e) => e.text), ['Interrupted by user', 'Execution failed: rate limited', 'Context compacted']);
  assert.equal(tr.busy, false);
  ingestAll(tr, [ev(8, 'session.shutdown', { shutdownType: 'routine', totalApiDurationMs: 1, sessionStartTime: 0, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }, modelMetrics: {}, currentTokens: 41000 })]);
  assert.equal(tr.ended, true);
  assert.equal(tr.context, 41000);
  ingestAll(tr, [ev(9, 'session.resume', { resumeTime: at(9), eventCount: 12 })]);
  assert.equal(tr.ended, false, 'a resumed session is open again');
});

test('reads top-level scalars from workspace.yaml', () => {
  const y = yamlScalars([
    `id: ${SID}`, 'cwd: C:\\Users\\dev\\acme', 'name: "Sum: fix \\"quoted\\""', 'user_named: true',
    "summary: 'it''s folded", "  over two lines'", 'summary_count: 0', 'nested:', '  key: value', 'block: |-', '  one', '  two',
  ].join('\n'));
  assert.equal(y.cwd, 'C:\\Users\\dev\\acme');
  assert.equal(y.name, 'Sum: fix "quoted"');
  assert.equal(y.user_named, true);
  assert.equal(y.summary, "it's folded over two lines");
  assert.equal(y.nested, undefined);
  assert.equal(y.block, 'one\ntwo');
});

test('collector finds live sessions, their status and names', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-copilot-'));
  const folder = path.join(home, 'session-state', SID);
  fs.mkdirSync(folder, { recursive: true });
  const log = path.join(folder, 'events.jsonl');
  const lines = (records) => records.map((r) => JSON.stringify(r) + '\n').join('');
  fs.writeFileSync(log, lines([start, ...turn]));
  const ws = (extra) => fs.writeFileSync(path.join(folder, 'workspace.yaml'),
    [`id: ${SID}`, 'cwd: /home/dev/acme', 'branch: main', 'summary_count: 0', `created_at: ${at(0)}`, ...extra].join('\n') + '\n');
  ws([]);
  const lock = path.join(folder, `inuse.${process.pid}.lock`); // this test's own process is alive
  fs.writeFileSync(lock, `${process.pid}\n`);
  fs.mkdirSync(path.join(home, 'session-state', 'not-a-session'));

  const dir = { root: home, sessions: path.join(home, 'session-state') };
  const c = new CopilotCollector({ running: () => true, dir });
  const events = new Map();
  c.on('events', (key, evs) => events.set(key, [...(events.get(key) || []), ...evs]));
  c.scanRecent();
  c.tick();

  let snap = c.snapshot();
  assert.equal(snap.length, 1);
  let a = snap[0];
  assert.equal(a.key, `copilot:${SID}`);
  assert.ok(!a.key.includes('/'));
  assert.equal(a.kind, 'copilot');
  assert.equal(a.live, true);
  assert.equal(a.status, 'working');
  assert.equal(a.now.verb, 'Calling', 'the MCP call is still running');
  assert.equal(a.project, 'acme');
  assert.equal(a.version, '1.0.116');
  assert.deepEqual(a.subagents, []);
  assert.equal(a.name, 'fix the failing sum test', 'without a name the first prompt names it here…');
  assert.equal(a.nameFromPrompt, true);
  assert.equal(a.title, '');
  assert.equal(shareAgents([a], 'activity')[0].name, 'acme', '…but not on a hub below full');
  for (const level of ['metadata', 'activity']) {
    assert.ok(!JSON.stringify(shareAgents(snap, level)).includes('failing sum'), `no prompt text at ${level}`);
  }
  assert.ok(events.get(`copilot:${SID}`).some((e) => e.kind === 'tool' && e.name === 'bash'));
  assert.ok(c.allEvents(200)[`copilot:${SID}`].length > 0);
  assert.ok(c.hasLive());

  // Copilot's own summary of the conversation is a derived name; a /rename is a title.
  ws(['name: Fix the sum test', 'user_named: false', 'summary: Fix the sum test']);
  fs.utimesSync(path.join(folder, 'workspace.yaml'), new Date(), new Date(Date.now() + 5000));
  c.scanRecent();
  a = c.snapshot()[0];
  assert.equal(a.name, 'Fix the sum test');
  assert.equal(a.nameFromPrompt, true);
  assert.equal(a.title, '');
  ws(['name: Sum fix', 'user_named: true']);
  fs.utimesSync(path.join(folder, 'workspace.yaml'), new Date(), new Date(Date.now() + 10000));
  c.scanRecent();
  a = c.snapshot()[0];
  assert.equal(a.title, 'Sum fix');
  assert.equal(shareAgents([a], 'activity')[0].name, 'Sum fix');

  fs.appendFileSync(log, lines([...done, ev(12, 'user.message', { content: 'ship it' }), ev(12, 'assistant.turn_start', { turnId: '3' }),
    ev(12, 'tool.execution_start', { toolCallId: 'call_6', toolName: 'ask_user', arguments: { question: 'Which branch?', choices: ['main', 'dev'] } })]));
  c.tick();
  a = c.snapshot()[0];
  assert.equal(a.status, 'waiting', 'ask_user waits for the user');
  assert.equal(a.now.verb, 'Needs you');

  fs.appendFileSync(log, lines([ev(13, 'abort', { reason: 'user_initiated' })]));
  c.tick();
  a = c.snapshot()[0];
  assert.equal(a.status, 'idle');
  assert.equal(a.now.verb, 'Your turn');

  fs.rmSync(lock);
  c.tick();
  c.tick();
  a = c.snapshot()[0];
  assert.equal(a.live, false, 'no in-use lock: the session ended');
  assert.equal(a.status, 'offline');

  // A lock left by a process that is gone isn't a live session.
  fs.writeFileSync(path.join(folder, 'inuse.99999999.lock'), '99999999\n');
  const stale = new CopilotCollector({ running: () => true, dir });
  stale.scanRecent();
  assert.equal(stale.snapshot()[0].live, false);
  fs.rmSync(home, { recursive: true, force: true });
});
