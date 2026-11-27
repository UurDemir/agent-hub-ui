// Prometheus text format for the dashboard's /metrics (opt-in with --metrics). Numbers and a few
// coerced labels only: machine, tool kind, status, model. No names, paths or text from sessions.

const esc = (v) => String(v ?? '').slice(0, 100).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const labels = (o) => `{${Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
const kindOf = (a) => (['codex', 'openclaw', 'gemini', 'opencode', 'copilot'].includes(a.kind) ? a.kind : 'claude');
const STATUSES = ['working', 'waiting', 'idle', 'offline'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function metrics({ agents = [], machines = null, others = [], host = '' }) {
  const out = [];
  const metric = (name, help, rows) => {
    out.push(`# HELP agent_hub_${name} ${help}`, `# TYPE agent_hub_${name} gauge`);
    for (const [l, v] of rows) out.push(`agent_hub_${name}${labels(l)} ${v}`);
  };
  const machineOf = (a) => a.machine || host || 'local';
  const group = (keyFn, valFn) => {
    const m = new Map();
    for (const a of agents) {
      const k = JSON.stringify(keyFn(a));
      m.set(k, (m.get(k) || 0) + valFn(a));
    }
    return [...m].map(([k, v]) => [JSON.parse(k), v]);
  };

  metric('agents', 'Agents shown, by machine, tool and status.',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a), status: STATUSES.includes(a.status) ? a.status : 'offline' }), () => 1));
  metric('subagents_working', 'Subagents currently working, by machine and tool.',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a) }), (a) => (a.subagents || []).filter((s) => s.status === 'working').length));
  metric('output_tokens', 'Output tokens of the sessions shown (they drop out when a session leaves the dashboard).',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a), model: a.model || '' }),
      (a) => num(a.outTokens) + (a.subagents || []).reduce((n, s) => n + num(s.outTokens), 0)));
  metric('context_tokens', 'Context size of live sessions, by machine and tool.',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a) }), (a) => (a.live ? num(a.context) : 0)));
  metric('cost_usd', 'Estimated cost of the sessions shown, in USD.',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a) }),
      (a) => num(a.cost) + (a.subagents || []).reduce((n, s) => n + num(s.cost), 0)));
  metric('tool_calls', 'Tool calls of the sessions shown.',
    group((a) => ({ machine: machineOf(a), kind: kindOf(a) }), (a) => num(a.toolCount)));
  metric('other_tool_processes', 'Processes of other AI tools seen, by machine and tool.',
    others.map((o) => [{ machine: o.machine || host || 'local', tool: String(o.id || '').split(':').pop() }, (o.pids || []).length]));
  if (machines) {
    metric('machine_online', 'Whether a reporting machine is connected (1) or not (0).',
      machines.map((m) => [{ machine: m.name }, m.online ? 1 : 0]));
    metric('machine_last_seen_seconds', 'Unix time of the last report from each machine.',
      machines.filter((m) => !m.local).map((m) => [{ machine: m.name }, Math.round(num(m.lastSeen) / 1000)]));
    metric('machine_outdated', 'Whether a reporting machine runs a version older than the hub needs (1).',
      machines.filter((m) => !m.local).map((m) => [{ machine: m.name }, m.outdated ? 1 : 0]));
  }
  return out.join('\n') + '\n';
}
