# Changelog

## 0.9.0

- Workspace side panel: project files, diffs and image or page previews, plus a "This chat" tab listing the files touched in the current chat. File routes are confined to the project and block secret files.
- Pull request from applied changes: a confirm step in the review drawer commits to a new branch, pushes and opens a PR with `gh` (or returns a compare link). UI only; the orchestrator has no tool for it.
- Conflict check before Apply, so overlapping edits from different workers are flagged first.
- Model shootout: on request, the same task goes to two or three models as parallel write jobs and you compare them. Allowed only when you ask for it in the current turn.
- Dictation: a microphone button in the composer of the Mac app.
- Quota pacing and provider cooldowns: reset times parsed from limit errors, providers in cooldown skipped, Gemini 5-hour and daily counters, pacing settings.
- Free models: availability probe, down models skipped for 4 hours, fallbacks kept, tool-use ranking. Codex orchestrator model choices.
- Rojo-aware project map for Roblox projects (`project_map` tool, cached).
- Mac app: open a folder from the app, lighter UI, restore of last projects, welcome window instead of a folder dialog. Notifications only from the app, one limit notice per window.
- Fixes: repeated compaction, git setup offered in non-git folders. Benchmarks: Claude Haiku 5.5 (TB 4.0 40.0) and GPT-6.1 Terra (51.8) added.
- Website: https://tokenwise.site, with canonical URL, sitemap and structured data. New README and screenshots.

## 0.8.0

- Undo Apply: every Apply records a git snapshot of the index and working tree under `refs/tokenwise/pre-apply/` (last 30 kept, no change to your branch or `HEAD`). Undo restores only the files the Apply touched and refuses, naming the files, if they changed since.
- Combined check: after Apply, run the project's tests plus an optional lint command in the working tree (no shell, 10 minute timeout). Optional "Check after Apply" setting and a "Check combined changes" button.
- Roblox Studio Output import: paste Studio Output, get deduplicated errors and stack traces (warnings ignored, 20 KB cap) mapped to source files through Rojo project files, and send the selected ones to the orchestrator.
- Fixes: discarding or timing out a job now stops its whole worker process group (SIGTERM, then SIGKILL) and a discarded job is no longer marked failed or re-run; image jobs run only on Codex; the studio polls faster with less work (cached job list and incremental usage totals).
- Stale-server fix: servers report the version they started with (`version` in `/api/state` and `loaded` in `/api/version`). The Mac app reuses a registered server only if its version matches the app, otherwise it asks it to quit and starts a fresh one. New local, CSRF-protected `POST /api/quit`. If the page scripts fail to load, a banner explains what to do (English and Turkish). When its server disappears the app shows "Restarting…" and starts a new one once. `tokenwise-studio update` now stops running studio servers after installing.
- Automatic updates: Settings > Updates with Automatic (default), Notify only and Off. Automatic installs new versions in the background at most once per 24 hours, never while work is running and never over a git checkout, logs to `~/.tokenwise-studio/update.log`, and offers "Restart now". The Mac app is rebuilt on restart when its Swift launcher changed.
- Fixes found in review: a worker's diff no longer detects renames, so Undo restores the old path as well as removing the new one; Studio Output parsing no longer takes quadratic time on very long runs of whitespace.

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
