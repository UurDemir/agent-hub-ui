import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareAgents, shareEvents, shareOthers, minLevel } from '../server/share.js';

const agent = {
  key: 's1', sessionId: 's1abcdef99', pid: 42, live: true, kind: 'interactive', project: 'app',
  cwd: '/home/dev/app', name: 'Fix the login bug', title: 'Fix the login bug', branch: 'fix/login',
  model: 'claude-opus-5-5', version: '2.1.0', status: 'working', rawStatus: 'busy',
  now: { verb: 'Running', label: 'Bash', summary: 'npm test', cat: 'run', since: 1 },
  lastSay: { text: 'I found the bug', t: 1 }, lastPrompt: 'please fix login', prs: [{ url: 'https://x/pr/1', number: 1, repo: 'x' }],
  todos: [{ content: 'write test', status: 'pending' }], outTokens: 10, cost: 0.5, context: 100, toolCount: 3,
  startedAt: 1, lastAt: 2, job: { state: 'running', detail: 'secret detail', intent: 'x', fan: [] },
  subagents: [{ key: 's1/a1', agentId: 'a1', type: 'Explore', description: 'look around', status: 'working', now: { verb: 'Reading', label: 'Read', summary: 'a.js', cat: 'read' } }],
  futureField: 'not listed, never sent',
};

test('metadata keeps status and numbers but no text from the session', () => {
  const [a] = shareAgents([agent], 'metadata');
  assert.equal(a.key, 's1');
  assert.equal(a.status, 'working');
  assert.equal(a.toolCount, 3);
  assert.equal(a.project, 'app');
  assert.equal(a.name, 'app');
  assert.deepEqual(a.now, { verb: 'Running', cat: 'run', since: 1 });
  assert.deepEqual(a.job, { state: 'running' });
  for (const k of ['cwd', 'title', 'branch', 'lastSay', 'lastPrompt', 'prs', 'todos', 'futureField']) assert.equal(k in a, false, k);
  assert.equal('description' in a.subagents[0], false);
});

test('activity adds titles, plans and tool summaries but not prompts or replies', () => {
  const [a] = shareAgents([agent], 'activity');
  assert.equal(a.title, 'Fix the login bug');
  assert.equal(a.branch, 'fix/login');
  assert.equal(a.now.summary, 'npm test');
  assert.equal(a.todos.length, 1);
  assert.equal(a.subagents[0].description, 'look around');
  for (const k of ['cwd', 'lastSay', 'lastPrompt', 'futureField']) assert.equal(k in a, false, k);
  // Without a running tool the summary is Claude's reply, which stays private.
  const [idle] = shareAgents([{ ...agent, now: { verb: 'Your turn', summary: 'I found the bug' } }], 'activity');
  assert.equal('summary' in idle.now, false);
});

test('full sends everything that is listed, and still nothing that is not', () => {
  const [a] = shareAgents([agent], 'full');
  assert.equal(a.cwd, '/home/dev/app');
  assert.equal(a.lastPrompt, 'please fix login');
  assert.equal(a.job.detail, 'secret detail');
  assert.equal('futureField' in a, false);
});

test('events are filtered by kind and field', () => {
  const events = [
    { id: '1', t: 1, kind: 'prompt', text: 'secret prompt' },
    { id: '2', t: 2, kind: 'say', text: 'secret reply' },
    { id: '3', t: 3, kind: 'tool', toolId: 'x', name: 'Bash', label: 'Bash', cat: 'run', summary: 'npm test', detail: 'npm test --secret' },
    { id: '4', t: 4, kind: 'result', toolId: 'x', ok: true, ms: 50, text: 'secret output' },
    { id: '5', t: 5, kind: 'note', text: 'Context compacted' },
    { id: '6', t: 6, kind: 'mystery', text: 'unknown kinds are dropped' },
  ];
  const meta = shareEvents(events, 'metadata');
  assert.deepEqual(meta.map((e) => e.kind), ['tool', 'result']);
  assert.deepEqual(meta[0], { id: '3', t: 3, kind: 'tool', toolId: 'x', name: 'Bash', label: 'Bash', cat: 'run' });
  assert.deepEqual(meta[1], { id: '4', t: 4, kind: 'result', toolId: 'x', ok: true, ms: 50 });
  const act = shareEvents(events, 'activity');
  assert.deepEqual(act.map((e) => e.kind), ['tool', 'result', 'note']);
  assert.equal(act[0].summary, 'npm test');
  assert.equal('detail' in act[0], false);
  assert.equal('text' in act[1], false);
  assert.deepEqual(shareEvents(events, 'full').map((e) => e.kind), ['prompt', 'say', 'tool', 'result', 'note']);
  // Below full, notes only carry fixed labels: an API error or task summary can quote the work.
  const notes = shareEvents([{ kind: 'note', text: 'Context compacted' }, { kind: 'note', text: 'Rate limited while editing billing.ts' }], 'activity');
  assert.deepEqual(notes.map((e) => e.text), ['Context compacted', 'Note (details not shared)']);
});

test('values are coerced so a hostile reporter cannot inject markup', () => {
  const [a] = shareAgents([{ ...agent, status: '<img src=x onerror=alert(1)>', toolCount: '<b>', pid: '1"', now: { cat: '"><script>' } }], 'full');
  assert.equal(a.status, 'offline');
  assert.equal(a.toolCount, 0);
  assert.equal(a.pid, null);
  assert.equal(a.now.cat, null);
  const [e] = shareEvents([{ id: 'x', t: '1', kind: 'tool', cat: 'evil', name: { a: 1 } }], 'full');
  assert.equal(e.t, null);
  assert.equal(e.cat, 'other');
  assert.equal(e.name, '');
  assert.deepEqual(shareAgents('nope', 'full'), []);
  assert.throws(() => shareAgents([], 'everything'));
});

test('other tools hide their command line below full', () => {
  const o = { id: 'cursor', label: 'Cursor', pids: [1, 2], memory: 10, startedAt: 1, cmd: 'C:\\Users\\me\\cursor.exe' };
  assert.equal('cmd' in shareOthers([o], 'activity')[0], false);
  assert.equal(shareOthers([o], 'full')[0].cmd, o.cmd);
});

test('minLevel picks the more private level', () => {
  assert.equal(minLevel('full', 'metadata'), 'metadata');
  assert.equal(minLevel('activity', 'full'), 'activity');
});
