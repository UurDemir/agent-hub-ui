#!/usr/bin/env node
// Command-line entry for `npx agent-hub-ui` / `agent-hub`: parses flags, then starts the server.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `Agent Hub ${pkg.version}
${pkg.description}

Usage: agent-hub [options]

Options:
  -p, --port <port>          Port to listen on (default 4317, or $PORT)
      --host <host>          Address to bind (default 127.0.0.1, or $HOST).
                             Transcripts contain your code and prompts, so keep it local.
                             Any other address needs --viewer-password.
      --no-open              Don't open the browser
      --allow-send           Let the dashboard send messages to running Claude Code
                             sessions on this PC (through Claude Code's local messaging
                             socket). Only the opened tab can send; more tabs need the
                             one-use link printed in the terminal
  -v, --version              Print the version
  -h, --help                 Show this help

Report this machine's agents to a hub (off unless --report-to is given):
      --report-to <url>      The hub's ingest URL, e.g. https://agent-hub.example.com:4318
      --report-key-file <f>  File holding this machine's key (or set $AGENT_HUB_REPORT_KEY)
      --share <level>        What leaves this machine (default metadata):
                               metadata  status, project folder name, model, tokens,
                                         cost, tool names and timings
                               activity  + session titles, branches, plans, subagent
                                         tasks, PR links and one-line tool summaries
                               full      + prompts, replies, tool input and output,
                                         full paths
      --allow-http           Allow a plain http:// hub that isn't on this machine
                             (only on a network that is already encrypted, like a VPN)
      --headless             Report without serving this machine's own dashboard

Run a hub that shows agents from many machines:
      --hub                  Accept reports from the machines in the keys file
      --hub-keys <file>      Keys file: { "machines": [{ "name", "sha256", "share"? }] }
                             Re-read on change; remove an entry to revoke a machine.
                             (or put the same JSON in $AGENT_HUB_MACHINES, e.g. in a container)
      --new-key <name>       Print a new machine key and its keys-file entry, then exit
      --ingest-port <port>   Port reporters send to (default 4318)
      --ingest-host <host>   Address for the ingest port (default 0.0.0.0)
      --tls-cert <file>      Serve the ingest port over HTTPS with this certificate…
      --tls-key <file>       …and key (PEM)
      --allowed-host <host>  Also accept this Host header, as the browser sends it (name,
                             or name:port), e.g. your reverse proxy's public name
                             (repeatable). Such viewers don't get the Projects page.
      --viewer-password <p>  Ask for this password before showing the dashboard
                             (or set $AGENT_HUB_VIEWER_PASSWORD)

Reads Claude Code's state from ~/.claude (or $CLAUDE_CONFIG_DIR). Never writes to it.`;

const args = process.argv.slice(2);
const allowed = [];
let open = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
  const value = () => {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (!v) { console.error(`Missing value for ${flag}`); process.exit(1); }
    return v;
  };
  const port = (name) => {
    const p = Number(value());
    if (!Number.isInteger(p) || p < 1 || p > 65535) { console.error(`${name} must be a number between 1 and 65535`); process.exit(1); }
    return String(p);
  };
  switch (flag) {
    case '-h': case '--help': console.log(HELP); process.exit(0); break;
    case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
    case '--no-open': open = false; break;
    case '--open': open = true; break;
    case '-p': case '--port': process.env.PORT = port('--port'); break;
    case '--host': process.env.HOST = value(); break;
    case '--allow-send': process.env.AGENT_HUB_ALLOW_SEND = '1'; break;
    case '--report-to': process.env.AGENT_HUB_REPORT_TO = value(); break;
    case '--report-key-file': process.env.AGENT_HUB_REPORT_KEY_FILE = value(); break;
    case '--share': process.env.AGENT_HUB_SHARE = value(); break;
    case '--allow-http': process.env.AGENT_HUB_ALLOW_HTTP = '1'; break;
    case '--headless': process.env.AGENT_HUB_HEADLESS = '1'; break;
    case '--hub': process.env.AGENT_HUB_HUB = '1'; break;
    case '--hub-keys': process.env.AGENT_HUB_KEYS = value(); break;
    case '--ingest-port': process.env.AGENT_HUB_INGEST_PORT = port('--ingest-port'); break;
    case '--ingest-host': process.env.AGENT_HUB_INGEST_HOST = value(); break;
    case '--tls-cert': process.env.AGENT_HUB_TLS_CERT = value(); break;
    case '--tls-key': process.env.AGENT_HUB_TLS_KEY = value(); break;
    case '--allowed-host': allowed.push(value()); break;
    case '--viewer-password':
      process.env.AGENT_HUB_VIEWER_PASSWORD = value();
      console.warn('Note: other users of this machine can see --viewer-password in the process list. $AGENT_HUB_VIEWER_PASSWORD keeps it out.');
      break;
    case '--new-key': {
      const { newMachineKey } = await import('../server/hub.js');
      const name = value();
      try {
        const { key, entry } = newMachineKey(name);
        console.log(`Key for "${name}". Give it to that machine only; the hub keeps just the hash.

  On ${name}:   AGENT_HUB_REPORT_KEY=${key}
               (or save it to a file and pass --report-key-file <file>)

  In the hub's keys file, add to "machines":
    ${JSON.stringify(entry)}`);
        process.exit(0);
      } catch (e) { console.error(e.message); process.exit(1); }
      break;
    }
    default: console.error(`Unknown option: ${a}\n\n${HELP}`); process.exit(1);
  }
}

if (allowed.length) process.env.AGENT_HUB_ALLOWED_HOSTS = [process.env.AGENT_HUB_ALLOWED_HOSTS, ...allowed].filter(Boolean).join(',');
if (open && process.env.AGENT_HUB_HEADLESS !== '1') process.env.AGENT_HUB_OPEN = '1';
await import('../server/index.js');
