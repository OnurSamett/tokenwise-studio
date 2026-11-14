# Changelog

## 0.7.0

- Turkish UI: a Language setting (Auto, English, Türkçe) for the interface and desktop notifications. Auto picks Turkish when the browser or system language is Turkish.
- Compact long chats: when the orchestrator's context passes a threshold (default 120k tokens, set 60k to 400k in Settings), the earlier conversation is summarized with Claude Haiku (or a local fallback) and a fresh session continues from the summary. A "Compact now" action sits in the chat menu.
- Research role: a Web research role in Team settings and `role="research"` on `delegate`. Read-only research jobs get live web search on Claude and Codex only for that role; answers carry numbered citations and a Sources list, and only http and https links are clickable. Free and local workers are not supported.
- Fixes found in review: compaction input is scrubbed of inline image data and long base64 runs, and several Turkish strings now use the informal "sen" form consistently.

## 0.6.0

- Chat export and backup: export a chat as Markdown or JSON from its ... menu, `tokenwise-studio export [--chat <id>] [--out <dir>]` for the command line, and a "Back up all chats" button in Settings that copies chats, jobs and their images to `~/.tokenwise-studio/backups/<project>/<timestamp>/`.
- Project instructions: a `TOKENWISE.md` in the project root (or `.tokenwise-studio/instructions.md`) is added to the orchestrator's guide every turn, and its "## For workers" section goes to workers. Edit it from Settings. It cannot override the review and plan-only rules.
- Turn budget: an optional token budget per turn (50k to 500k) covering the orchestrator and its workers. A notice appears at 80%; at 100% the orchestrator can no longer start new jobs and wraps up. The turn footer now shows the turn's total tokens.
- Usage screen: a Usage drawer in the sidebar with tokens and API-equivalent cost per day (last 14 days, inline SVG chart) and per agent and model, totals, and your plan-limit readings. `GET /api/usage?days=14`.
- Generated images in chat: png, jpg, webp and gif files a write worker creates show as thumbnails in the job card, the job drawer and the review, with a lightbox, and are applied like other files. Served only from the job's worktree or `.tokenwise-studio/artifacts/`, images only, 15 MB cap. The orchestrator now sends image generation to Codex.
- Test runner: per-project test command (npm test, pytest, go test, cargo test; override in Settings). A Run tests button in the review and job drawer runs it in the job's worktree (no shell, 10 minute timeout) and shows pass or fail with the output tail. Optional "Run tests before Apply" runs it automatically and shows a chip. New `job_test` MCP tool for the orchestrator.
- Mac app: file downloads now work. The chat Export saves to ~/Downloads without overwriting existing files and shows the file in Finder.

## 0.5.0

- Images in chat: attach, paste or drop images in the composer; they go to the orchestrator and to Codex and Claude workers.
- Thinking steps: the model's reasoning shows as a collapsible "Thinking" section.
- Settings panel: permission mode (ask, auto-apply, plan-only), default orchestrator model and effort, and what happens when Claude hits its limit (switch automatically, ask me, or off), plus threshold, fallback order, free models, fast mode, notifications and update checks.

## 0.4.0

- Native Mac window: tokenwise studio opens in its own app window instead of a browser tab.
- Desktop notifications when a task finishes or needs review.
- The orchestrator falls back to Codex when Claude is unavailable or out of limits.
- Terminal-Bench 4.0 ranking in the model guide.
- Sidebar orchestrator card showing who runs the next message.
- `tokenwise-studio update [--check]`, plus a quiet "New version" notice in the sidebar.

## 0.3.0

- `tokenwise-studio setup`, `doctor` and `uninstall`.
- Mac launcher app (`~/Applications/tokenwise studio.app`).
