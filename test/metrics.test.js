import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../server/metrics.js';
import { versionBelow, MIN_REPORTER } from '../server/hub.js';

test('metrics are counts with coerced labels, and no session text', () => {
  const agents = [
    { key: 'a', kind: 'interactive', status: 'working', live: true, model: 'claude-opus-5-5', outTokens: 100, context: 5000, cost: 0.5, toolCount: 3, name: 'fix the login bug', cwd: '/home/dev/secret-project', subagents: [{ status: 'working', outTokens: 10, cost: 0.1 }] },
    { key: 'pc:b', machine: 'pc', kind: 'codex', status: 'idle', live: true, model: 'gpt-5.5-codex', outTokens: 50, context: 100, cost: null, toolCount: 1, subagents: [] },
    { key: 'pc:c', machine: 'pc', kind: 'codex', status: 'idle', live: false, model: 'gpt-5.5-codex', outTokens: 5, subagents: [] },
  ];
  const machines = [{ id: '@local', name: 'nas', local: true, online: true }, { id: 'pc', name: 'pc"x', online: false, lastSeen: 1795740000000, outdated: true }];
  const text = metrics({ agents, machines, others: [{ id: 'pc:cursor', machine: 'pc', pids: [1, 2] }], host: 'nas' });
  assert.match(text, /^# HELP agent_hub_agents /m);
  assert.match(text, /^agent_hub_agents\{machine="nas",kind="claude",status="working"\} 1$/m);
  assert.match(text, /^agent_hub_agents\{machine="pc",kind="codex",status="idle"\} 2$/m);
  assert.match(text, /^agent_hub_output_tokens\{machine="nas",kind="claude",model="claude-opus-5-5"\} 110$/m);
  assert.match(text, /^agent_hub_cost_usd\{machine="nas",kind="claude"\} 0.6$/m);
  assert.match(text, /^agent_hub_context_tokens\{machine="pc",kind="codex"\} 100$/m, 'only live sessions count toward context');
  assert.match(text, /^agent_hub_other_tool_processes\{machine="pc",tool="cursor"\} 2$/m);
  assert.match(text, /^agent_hub_machine_online\{machine="pc\\"x"\} 0$/m, 'quotes in labels are escaped');
  assert.match(text, /^agent_hub_machine_outdated\{machine="pc\\"x"\} 1$/m);
  assert.ok(!text.includes('login bug') && !text.includes('secret-project'));
});

test('reporters older than the minimum version are flagged', () => {
  assert.equal(versionBelow('0.5.0', MIN_REPORTER), true);
  assert.equal(versionBelow('0.4.9', '0.5.1'), true);
  assert.equal(versionBelow('0.5.1', '0.5.1'), false);
  assert.equal(versionBelow('0.10.0', '0.5.1'), false);
  assert.equal(versionBelow('1.0.0-beta.1', '0.5.1'), false);
  assert.equal(versionBelow('', '0.5.1'), true, 'an unknown version is treated as old');
  assert.equal(versionBelow('garbage', '0.5.1'), true);
});
