---
name: verify-ui
description: Launch Agent Hub on a spare port and check it in the user's Chrome with the Claude in Chrome extension — live view, agent detail panel and projects page — reading console errors and taking screenshots. Use after UI or server changes, or when asked to run, start, screenshot or verify the dashboard.
---

# Verify the Agent Hub UI

Use the **Claude in Chrome** extension (`mcp__claude-in-chrome__*`) for browser checks, not Playwright. Load the `anthropic-skills:chrome-browser` skill before the first browser step, and load the tools in one ToolSearch call: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `computer`, `read_page`, `find`, `javascript_tool`, `read_console_messages`.

The user's own dashboard usually runs on port 4317. Never stop it or test against it; use port 4399.

1. **Tests first**: `npm test`. Fix failures before looking at the UI.

2. **Start a test server** in the background (Bash tool, `run_in_background: true`):
   ```
   PORT=4399 node server/index.js
   ```
   Wait until `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4399/api/agents` returns `200`.

3. **Open a tab**: call `tabs_context_mcp` first, then `tabs_create_mcp` and work only in that new tab. Never reuse the user's tabs (including their 4317 dashboard). If the extension isn't connected or doesn't respond, say so and stop; don't fall back to another browser without asking.

4. **Live view**:
   - `navigate` the new tab to `http://127.0.0.1:4399/`.
   - Check with `javascript_tool` or `read_page`: the header shows the host name (not "connecting…"), and the Agents section lists at least the current Claude Code session — this session is itself a live agent, so an empty list means the collector is broken. The page exposes `state` (agents, events) as a global, which makes precise checks easy.
   - Click that agent's card (`computer` left_click, or `.click()` via `javascript_tool`) and confirm the detail panel shows a timeline of prompts and tool calls.
   - `read_console_messages` with `onlyErrors: true`: there must be no errors.
   - `computer` screenshot of the page.

5. **Projects page**:
   - `navigate` to `http://127.0.0.1:4399/#/projects`: "Your global setup" and this project are listed.
   - Open this project and the tabs the change touched (Agents, Skills, Hooks…) via `#/projects/<id>/<tab>`. Each should render without "Couldn't load this project".
   - Check console errors again and take a screenshot.

6. **Check the specific change**: whatever the change was meant to do, find it on the page and confirm it (DOM values, computed styles, a screenshot). Saying "the page loads" is not enough.

7. **Clean up**: close the tab you created with `tabs_close_mcp`, then stop the background server (TaskStop, or kill its PID).

Don't click anything that opens a browser dialog (the Notifications button asks for permission). Report what you checked, what you saw, and any console errors.
