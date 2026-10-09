#!/usr/bin/env node
// Command-line entry for `npx agent-hub-ui` / `agent-hub`: parses flags, then starts the server.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `Agent Hub ${pkg.version}
${pkg.description}

Usage: agent-hub [options]

Options:
  -p, --port <port>   Port to listen on (default 4317, or $PORT)
      --host <host>   Address to bind (default 127.0.0.1, or $HOST).
                      Transcripts contain your code and prompts, so keep it local.
      --no-open       Don't open the browser
      --allow-send    Let the dashboard send messages to running Claude Code
                      sessions (through Claude Code's local messaging socket)
  -v, --version       Print the version
  -h, --help          Show this help

Reads Claude Code's state from ~/.claude (or $CLAUDE_CONFIG_DIR). Never writes to it.`;

const args = process.argv.slice(2);
let open = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (!v) { console.error(`Missing value for ${a}`); process.exit(1); }
    return v;
  };
  if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
  else if (a === '--no-open') open = false;
  else if (a === '--open') open = true;
  else if (a === '--allow-send') process.env.AGENT_HUB_ALLOW_SEND = '1';
  else if (a === '-p' || a.startsWith('--port')) {
    const port = Number(value());
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('--port must be a number between 1 and 65535'); process.exit(1); }
    process.env.PORT = String(port);
  } else if (a.startsWith('--host')) process.env.HOST = value();
  else { console.error(`Unknown option: ${a}\n\n${HELP}`); process.exit(1); }
}

if (open) process.env.AGENT_HUB_OPEN = '1';
await import('../server/index.js');
