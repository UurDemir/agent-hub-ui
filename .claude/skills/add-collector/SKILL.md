---
name: add-collector
description: Add live activity support for another coding agent (Codex CLI, Gemini CLI, Aider, opencode…) by writing a collector that reads its local logs and emits Agent Hub's event shape. Use when asked to support, track or show another agent's activity, not just its process.
---

# Add a collector for another agent

Today only Claude Code has full activity (`server/claude.js`). Other tools are detected by process name only (`AGENTS` in `server/processes.js`). A collector turns another tool's local logs into the same events and summaries, so it gets swimlanes, cards and a detail panel.

## 1. Find the real log format — don't guess

- Find where the tool stores sessions or history on this machine (its docs, then the folders under the home directory). Check that the tool is installed and has actually written logs.
- Read a **small sample** of real records: list the keys and record types, and only quote what you need. Logs contain the user's private code and prompts.
- If the tool isn't installed or has no logs, stop and ask the user for sample files. Never write a parser for a format you haven't seen.
- Work out: how to tell live sessions from ended ones, where the working directory is, and how tool calls and their results are linked.

## 2. Write `server/<tool>.js`

Mirror `ClaudeCollector`:

- An `EventEmitter` with `start()`, emitting `'events'` with `(key, events)` and `'tick'`.
- `snapshot()` returns summaries with the fields the frontend reads: `key`, `name`, `status` (`working` | `waiting` | `idle` | `offline`), `live`, `now` (`{ verb, label, summary, cat, since }`, see `activity()` in `server/parse.js`), `project`, `cwd`, `branch`, `model`, `startedAt`, `lastAt`, `toolCount`, `outTokens`, `context`, `subagents` (use `[]`), plus `kind` set to the tool's id.
- `allEvents(limit)` returns `{ [key]: events }` for the SSE `init` frame.
- Events use the existing kinds: `prompt`, `say`, `tool` (with `toolId`, `name`, `label`, `cat`, `summary`, `detail`), `result` (with `toolId`, `ok`, `text`, `ms`), `note`. Give each a unique `id` and a `t` timestamp.
- Reuse `Tail` for JSONL files and `clip()` for every text field. Map the tool's own tool names to the existing categories (`read`, `edit`, `run`, `web`, `agent`, `mcp`, `plan`, `ask`, `other`); don't add a new category unless you also add it to `CATS` in `public/app.js` and a `--c-<cat>` color in `public/styles.css`.
- **Keys must be unique and must not contain `/`**: the frontend treats `parent/child` keys as subagents. Prefix them, e.g. `codex:<sessionId>`.
- Read-only, and no dependencies.

## 3. Wire it into `server/index.js`

- Start it next to `claude`, forward its `'events'` to `broadcast('events', …)`.
- Merge its `snapshot()` into the `agents` broadcast, `/api/agents` and the `init` frame, and merge its `allEvents()` into `init`.
- Broadcast `agents` on its `'tick'` too, with the same change detection (`lastAgents`).
- Filter its tool out of `procs.others` so it isn't listed twice.

## 4. Test and document

- Add `test/<tool>.test.js` with small hand-written records that follow the real format you saw (no real user content), covering tool call + result linking, prompts and status.
- `npm test`, then use the `verify-ui` skill to check the agent appears in the live view.
- Update the source table in `README.md` and the architecture section of `CLAUDE.md`.
