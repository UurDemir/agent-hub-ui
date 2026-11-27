import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fake ~/.claude, set before claude.js reads CLAUDE_CONFIG_DIR.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-history-'));
process.env.CLAUDE_CONFIG_DIR = home;
const { LocalHistory, dayOf } = await import('../server/history.js');

const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const write = (folder, id, records, ageH = 0) => {
  const dir = path.join(home, 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const when = (Date.now() - ageH * 3600e3) / 1000;
  fs.utimesSync(f, when, when);
  return f;
};
const assistant = (h, id, text, usage, model = 'claude-opus-5-5') => ({
  type: 'assistant', timestamp: t(h), uuid: `a-${id}`, message: { id, model, usage, content: [{ type: 'text', text }] },
});

write('-w-shop', 'aaaa1111', [
  { type: 'user', timestamp: t(30), uuid: 'u1', cwd: '/w/shop', gitBranch: 'main', message: { role: 'user', content: 'Add a "quantity" field to the cart' } },
  assistant(30, 'm1', 'Done, the cart has a quantity field.', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000 }),
  assistant(30, 'm1', 'Done, the cart has a quantity field.', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
  { type: 'ai-title', aiTitle: 'Cart quantity field' },
  { type: 'cost-state', totalCostUSD: 1, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, costUSD: 0.5 } } },
], 30);
write('-w-shop--claude-worktrees-agent-x', 'bbbb2222', [
  { type: 'user', timestamp: t(2), uuid: 'u2', cwd: '/w/shop/.claude/worktrees/agent-x', message: { role: 'user', content: 'Fix the flaky checkout test' } },
  assistant(2, 'm2', 'The test now waits for the network.', { input_tokens: 10, output_tokens: 5 }),
  { type: 'user', timestamp: t(2), uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'quantity mentioned only in tool output' }] } },
], 2);

const h = new LocalHistory();

test('lists past sessions newest first, named by title or first prompt', async () => {
  const { sessions } = await h.list();
  assert.deepEqual(sessions.map((s) => s.key), ['bbbb2222', 'aaaa1111']);
  assert.equal(sessions[1].name, 'Cart quantity field');
  assert.equal(sessions[1].branch, 'main');
  assert.equal(sessions[0].name, 'Fix the flaky checkout test');
  assert.equal(sessions[0].project, 'shop', 'a worktree session belongs to its repo');
});

test('search finds text in prompts and replies, not in tool output', async () => {
  const { sessions } = await h.list({ q: 'quantity' });
  assert.deepEqual(sessions.map((s) => s.key), ['aaaa1111']);
  assert.match(sessions[0].match.text, /quantity/);
  assert.equal(sessions[0].match.who, 'prompt');
  const quoted = await h.list({ q: '"quantity"' });
  assert.equal(quoted.sessions.length, 1, 'quotes are matched inside JSON strings');
  assert.equal((await h.list({ q: 'NETWORK' })).sessions[0].match.who, 'reply', 'case-insensitive');
});

test('a past session loads with its events; ids are checked', () => {
  const s = h.session('aaaa1111');
  assert.equal(s.agent.key, 'history:aaaa1111');
  assert.deepEqual(s.events.map((e) => e.kind), ['prompt', 'say', 'say']);
  assert.equal(s.agent.outTokens, 50, 'usage of one message counts once');
  assert.equal(h.session('../../etc/passwd'), null);
  assert.equal(h.session('nope'), null);
});

test('usage adds up tokens per day, project and model, priced from cost-state', async () => {
  const u = await h.usageReport(7);
  const total = u.byDay.reduce((n, d) => n + d.out, 0);
  assert.equal(total, 55);
  assert.equal(u.priced, true);
  assert.deepEqual(u.byProject.map((p) => [p.project, p.sessions]), [['shop', 2]]);
  assert.equal(u.byModel[0].model, 'claude-opus-5-5');
  assert.ok(u.byDay.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.day)));
  assert.ok(u.byDay.some((d) => d.day === dayOf(Date.now() - 30 * 3600e3) && d.cost > 0));
  const short = await h.usageReport(1);
  assert.equal(short.byDay.reduce((n, d) => n + d.out, 0) <= 55, true);
  fs.rmSync(home, { recursive: true, force: true });
});
