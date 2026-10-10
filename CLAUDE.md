# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start          # serve on http://127.0.0.1:4317
npm run open       # same, and opens the browser
```

```
npm test                                              # node --test, runs test/*.test.js
node --test --test-name-pattern="redact" test/projects.test.js   # a single test
```

Node 20+, no dependencies, no build step, no `npm install`. Tests use the built-in `node:test`; there is no linter. Env vars: `PORT`, `HOST` (default `127.0.0.1`), `CLAUDE_CONFIG_DIR` (default `~/.claude`). Hub and reporter flags map to `AGENT_HUB_*` env vars set by `bin/agent-hub.js` (`PORT=0` / `AGENT_HUB_INGEST_PORT=0` pick a free port; the server logs the real one).

Distribution: published to npm as `agent-hub-ui` and run with `npx agent-hub-ui` (or `npx github:UurDemir/agent-hub-ui`). `bin/agent-hub.js` is the CLI (`--port`, `--host`, `--no-open`, `--help`); it sets env vars and imports `server/index.js`. Only `bin/`, `server/` and `public/` ship (the `files` list in `package.json`) — a new runtime file anywhere else won't be in the package; check with `npm pack --dry-run`. `.gitattributes` forces LF so the CLI's shebang works on macOS/Linux. Releases: bump `version`, push, then publish a GitHub release tagged `v<version>`; `.github/workflows/publish.yml` runs the tests and `npm publish` through npm trusted publishing (no token; the package's Trusted Publisher on npmjs.com points at this repo and `publish.yml`, so renaming the workflow breaks publishing). CI (`ci.yml`) runs the tests and a packed-CLI smoke test on Linux, Windows and macOS.

The server must be restarted to pick up changes in `server/`; files in `public/` are served with `no-cache`, so a browser reload is enough.

Port 4317 is often already taken by a running dashboard instance. To test server changes, start a second instance on another port and query it:

```
PORT=4399 npm start
curl http://127.0.0.1:4399/api/agents          # live agents + other AI tools
curl http://127.0.0.1:4399/api/projects/user   # global ~/.claude setup
```

## Project constraints

- **Zero dependencies.** Server uses only `node:` built-ins (ESM, `"type": "module"`); frontend is plain browser JS with no bundler or framework.
- **Read-only.** The app reads Claude Code's local state and never writes to `~/.claude`, `~/.claude.json` or project folders. The one way it acts on sessions is the opt-in `--allow-send` messaging (below). Keep that feature behind the flag, the one-use unlock codes and per-tab tokens, the Origin check, the anti-framing headers and the loopback-only rule in `server/index.js`. Never put a send token or unlock code in anything a GET returns (`/api/stream`, `/api/agents`): that would hand it to every local process.
- **Local-only.** It binds to `127.0.0.1` because transcripts contain code and prompts. Don't change the default host. `hostAllowed()` in `server/index.js` rejects requests whose `Host` header isn't the loopback address or an `--allowed-host` (DNS-rebinding protection); keep it in front of every new dashboard route. The only exceptions are opt-in hub mode (below): a reporter sends data only with `--report-to`, and a hub's network-facing ingest port only accepts keyed reports and serves nothing.
- **Multi-machine stays opt-in and minimal.** Everything a reporter sends and a hub keeps goes through the allowlists in `server/share.js`; a new agent or event field is private until listed there with its level. Those functions also coerce types, because remote data ends up in the hub's HTML (numbers and class names are interpolated without `esc()`). The sharing level is chosen on the reporting machine (`--share`, default `metadata`) and the keys file can only lower it. Never let the hub ask for more, never relay `--allow-send` to remote machines or accept it from remote viewers (`refuseSend()` rejects `remoteViewer()` requests, and they get no send epoch), and keep the hub dashboard refusing a non-loopback bind without `--viewer-password`.
- **Secrets stay hidden.** Anything that surfaces MCP commands, hook commands, env vars, headers or URLs goes through `redact()` / `redactUrl()` in `server/projects.js`; only env/header *names* are sent, never values.
- **Path access is limited to known projects.** `/api/projects/<id>` only reads projects found in `~/.claude.json` or `~/.claude/projects/`; static serving rejects paths outside `public/`.
- **Cross-platform.** Windows and POSIX are both supported (see the `win32` branches in `server/processes.js` and `norm()` in `server/projects.js`).

## Claude tooling in this repo

- Hooks (`.claude/settings.json`): every Edit/Write of a JS file runs `node --check`; when Claude stops with uncommitted JS changes, `npm test` runs and failures send it back to work.
- Subagents: `transcript-drift-checker` (after a Claude Code update, or when activity looks wrong) and `privacy-auditor` (before committing changes to `server/` or `public/`).
- Skills: `verify-ui` (check the dashboard in a browser on port 4399) and `add-collector` (support another agent's logs).

## Architecture

### Data flow

`server/index.js` wires three producers to one HTTP server:

1. **`ClaudeCollector`** (`server/claude.js`) — polls on a 1s tick. Live sessions come from `~/.claude/sessions/<pid>.json` (alive check via `process.kill(pid, 0)`); recently ended sessions are found by transcript mtime (limits are constants at the top of the file). Each session tails its `~/.claude/projects/<slug>/<sessionId>.jsonl`, its `…/<sessionId>/subagents/agent-*.jsonl` (+ `.meta.json`), and `~/.claude/jobs/<jobId>/state.json` for background jobs. Emits `events` (new UI events for a key) and `tick`.
2. **`ProcessScanner`** (`server/processes.js`) — every 10s lists OS processes (PowerShell `Get-CimInstance` on Windows, `ps` elsewhere) and matches them against the `AGENTS` table to detect other AI tools. Presence/memory/uptime only.
3. **`ProjectCatalog`** (`server/projects.js`) — on-demand (not streamed). Discovers projects and reads their Claude setup: CLAUDE.md, rules, agents, skills, commands, `.mcp.json`, settings/hooks/permissions, auto-memory, sessions, plugins. Usage counts come from regex scans over transcripts, cached by `size:mtime`.

Endpoints: `GET /api/stream` (SSE: `init` with full snapshot + last 200 events per key, then `agents`, `events`, `others`), `GET /api/agents`, `GET /api/projects`, `GET /api/projects/<id>` (`user` = global `~/.claude` setup), `POST /api/send/unlock` (`{code}` → `{token, epoch}`) and `POST /api/send` (`{key, text}` + `X-Agent-Hub-Token`), both only with `--allow-send`. The `agents` event is only broadcast when the JSON snapshot changes.

### Messaging sessions (`server/messaging.js`)

With `--allow-send` (env `AGENT_HUB_ALLOW_SEND=1`), `/api/send` delivers text to a live session through Claude Code's own cross-session messaging socket. The protocol is undocumented; it was read from the Claude Code 2.1.296 bundle:
- The session file's `messagingSocketPath` is a named pipe on Windows (`\\.\pipe\LOCAL\cc-msg-<32 hex>`) and a Unix socket elsewhere.
- The token is `peerToken` in `~/.claude/sessions/<pid>.<sha256(canonical socket path)>.key`. The canonical path is lowercased on Windows and `path.resolve`d elsewhere.
- Frames are newline-delimited JSON: `{"type":"auth","token"}`, then `{"type":"user","session_id","uuid","from":"agent-hub","message":{"role":"user","content"}}`. Claude Code drops a frame whose `session_id` doesn't match the session.
- The session receives it as a meta "message from another session". The transcript records it as an `attachment` of type `queued_command` with `origin: {kind: "peer", from}`. `parse.js` turns that into a `prompt` event with `from`, which the UI labels `YOU · HUB` or `SESSION`.

`canMessage` on an agent summary means the session is live and has a socket. How a tab gets a token:
- At startup the server makes a one-use unlock code. The CLI opens it as `<url>/#send=<code>`; with `--no-open` it prints it.
- `app.js` takes the code out of the hash, both on load and on `hashchange` (its listener runs before the router's). Once SSE `init` arrives, it trades the code at `/api/send/unlock`.
- The token is kept in `sessionStorage` (`hub.send`) together with the server run's `epoch`. SSE `init` carries only that epoch (`send`, `null` when sending is off); a saved token from another epoch is dropped.
- Each successful unlock prints a fresh link to the terminal.

`test/send.test.js` runs a real server and covers this flow.

### Hub and reporting (`server/hub.js`, `server/reporter.js`, `server/share.js`)

- **Reporter** (`--report-to <url>`): every ~1s POSTs gzipped JSON to `<url>/ingest` with `Authorization: Bearer <machine key>`: `{v, instance, seq, share, host, version}` plus either `init` (`agents`, `others`, `events` like SSE `init`) or the changes since the last post (`agents`, `others`, `events: [{key, events}]`), with a heartbeat every 5s. Data is filtered with `share.js` before it is sent. On any failure, or when the hub answers `needInit`, it drops its buffer and sends a fresh `init`. `ingestUrl()` refuses plain http off-machine without `--allow-http`. `--headless` starts no dashboard.
- **Hub** (`--hub --hub-keys <file>`): a second listener (`--ingest-port`, default `0.0.0.0:4318`, optional `--tls-cert/--tls-key`) with only `POST /ingest`. `Keyring` stores sha256 hashes, compares in constant time and re-reads the file on change (revocation). The machine name comes from the key entry, never from the report. `Hub.ingest()` requires `init` from an unknown instance or after a `seq` gap, refuses a second instance on the same key while the first is active (409), and re-applies `share.js` with `min(reported level, entry.share)`.
- Remote agent keys are `<machine>:<sessionId>` (subagents `<machine>:<sessionId>/<agentId>`, still split on `/` by the frontend); remote agents carry `machine`, `remote: true` and `share`. Local agents keep plain keys. A machine silent for 20s shows its agents as ended; it is dropped after 3h.
- SSE `init` also carries `machines` (`null` unless `--hub`; `@local` is this PC) and `reporting` (`null` unless `--report-to`); `machines` and `reporting` events update them. The frontend's machine filter only hides agents (`state.agents` vs `state.allAgents`); `byKey` keeps all of them so events aren't lost. Remote agents have no Projects page link; the canvas groups them per machine. `remoteViewer()` (a non-loopback bind, or a request through an `--allowed-host` name) gets 404 from `/api/projects*` and SSE `init.projects: false`, which hides the Projects tab: the hub PC's own CLAUDE.md, MCP and hook setup isn't covered by any sharing level.
- `test/remote.test.js` runs a real hub and a headless reporter against fake config dirs and checks that nothing above the sharing level reaches the hub.

### Transcript parsing (`server/parse.js`)

- `Tail` reads a growing JSONL file incrementally from a byte offset (starting `initialBytes` from the end, dropping the first partial line) and resets if the file shrinks.
- `Transcript.ingest(record)` turns one raw record into zero or more UI events — `prompt`, `say`, `tool`, `result`, `note`, `pr` — and keeps running state (model, context size, output tokens deduped by message id, todos from `TodoWrite`, PR links, branch, title, pending tool calls). `tool` and `result` events are linked by `toolId`; a result's `ms` comes from the pending tool's timestamp.
- `CATEGORY` / `toolCategory()` map tool names to the color categories used in the UI (`read`, `edit`, `run`, `web`, `agent`, `mcp`, `plan`, `ask`, `other`). New Claude Code tools land in `other` until added here; the same category list is mirrored in `public/app.js` (`CATS`) and as `--c-<cat>` CSS variables in `public/styles.css`.
- `activity()` produces the one-line "what is it doing now" for a card.

This file depends on Claude Code's undocumented transcript format (record `type`s like `ai-title`, `agent-name`, `last-prompt`, `pr-link`, `system`/`compact_boundary`; injected user text starting with `<` is skipped). When something shows up wrong in the UI, compare against a real transcript first.

To support another agent with local logs, write a collector like `server/claude.js` that emits the same event shape.

### Keys and slugs

- An agent key is the `sessionId`; a subagent key is `<sessionId>/<agentId>`. The frontend relies on this split to attach subagents to their parent. In hub mode, remote keys get a `<machine>:` prefix (machine names can't contain `/` or `:`).
- Project folder names in `~/.claude/projects` are the cwd with every non-alphanumeric char replaced by `-`. This rule is implemented separately in `server/claude.js`, `server/projects.js` (`slug`), inline in `public/app.js` (link to the project page), and `projectIdOf` in `public/canvas.js` — keep them in sync.

### Frontend (`public/`)

- Three classic (non-module) scripts sharing globals, loaded in this order: `app.js` (SSE client, shared `state` and helpers, live view: swimlanes, agent cards, detail panel, notifications), `canvas.js` (`#/canvas` and `#/canvas/<project id>`: a node graph drawn on a `<canvas>` — stars, edges, hexagons, rings — under an HTML layer of labels, tool-call boxes and bubbles that shares the same camera; it runs a `requestAnimationFrame` loop only while the view is visible, rebuilds its layout model at most every 500 ms or on data change, and has a timeline that can scrub or replay by filtering events to a time `T`), and `projects.js` (`#/projects…` view and the hash router, which runs on load — so `canvas.js` must load before it). `app.js` calls `renderCanvas()`/`canvasActivity()` on SSE updates.
- Project grouping on the canvas uses the same cwd → folder-name slug as `~/.claude/projects` and folds Claude Code worktrees (`<repo>/.claude/worktrees/<name>`) into their repo.
- Costs (`cost` on agents and subagents) are estimates: `costRates()` in `server/parse.js` derives a USD-per-weighted-token rate per model from Claude Code's own `cost-state` records, and `transcriptCost()` applies it to each transcript's per-message usage. No prices are hard-coded; `cost` is `null` until some session has a `cost-state` record.
- Rendering is template strings into `innerHTML`. Every interpolated value must go through `esc()`, and links through `safeUrl()`. The small Markdown renderer in `projects.js` escapes its input before formatting.
- UI preferences persist in `localStorage` under the `hub.` prefix via `store`.
