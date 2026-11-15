# Changelog

## 0.10.2

- Connect models: guided setup and sign-in instructions for Claude, Codex and Gemini, plus optional NVIDIA and Ollama guidance.
- Add Spanish, German and French interface and macOS welcome translations, including locale-aware dates, plural forms and dictation language selection. Translations were machine-generated and should receive native-speaker review.

## 0.10.1

Security fixes from the v0.10.0 audit.
- Updates are pinned to verified GitHub release commits; the npm registry package name is never queried or installed. Automatic updates now default to "Notify only"; a stored "Automatic" is read as Notify only once, with a note.
- Tools (git, claude, codex, npm) resolve to absolute paths from PATH, never from the project or working directory (Windows binary planting). The server no longer runs with the project as its working directory.
- Local server: GET /api needs a same-origin request or x-tokenwise; HTML refuses framing. The Mac app pins navigation and its bridge to its own server and confirms links that open unknown folders.
- Project-shipped test commands need a one-time confirmation; test runs no longer inherit API keys. Markdown/file-reference scanners are linear-time. zod 4.6.7, npm-shrinkwrap.json, `npm ci --ignore-scripts` for the DMG.
- Free models select responsive candidates using measured latency, show the active model label, and keep reasoning out of visible answers. Streaming and reasoning parsing now have size bounds and ReDoS protection.
- macOS 13.3+ is required for both CLI-built apps and DMG releases.

## 0.10.0

- Composer model + effort picker: compact control at the bottom-right next to Send (`⌘/`), grouping Claude (Opus, Sonnet, Haiku) and Codex (Sol, Terra, Luna) orchestrators, with effort sub-choice (`low`, `medium`, `high`, `xhigh`), fast mode switch, keyboard navigation, and live plan-limit switch hints from `/api/limits` and `/api/orchestrator`.
- Composer Team picker popover: opened from the Team chip with Auto, Quality, Balanced, Cheap, and Free presets, per-role cards (code, quick, review, research, images) showing provider logos, TB 4.0 scores, cost hints, plan-limit bars, recommended badges, one-line "why", and "This message only" vs "Save for project" (`team.json`) scope.
- `@mentions` routing: typing `@` in the composer opens a menu for `@codex`, `@claude`, `@gemini`, `@free`, `@local`, and models (`@sol`, `@terra`, `@luna`, `@opus`, `@sonnet`, `@haiku`, `@hydrogen`, `@argon`); mentions become chips, are validated server-side on `POST /api/chat`, and instruct the orchestrator for that message only.
- Sidebar folders, pinning, and date groups: create, rename, pin, collapse, and delete per-project folders stored in `.tokenwise-studio/folders.json` via validated `GET`/`POST /api/folders` (CSRF/Host protected; deleting a folder keeps its chats unfiled, and deleting a chat cleans up folder references). Supports dragging chats between folders/unfiled and keyboard-accessible "Move to folder…" / Pin options in the chat `⋯` menu, with `Today`, `Yesterday`, `Previous 7 days`, and `Older` grouping (`ui/sidebar.js`).
- Effort-aware working animations & sticky banner: running turns display an effort-scaled orb/shimmer indicator (`low` → `xhigh`), per-worker progress bars and running indicators reflect each worker's effort, and a sticky `"Working · Stop"` banner stays pinned at the top of the chat; respects `@media (prefers-reduced-motion: reduce)` and a new Settings toggle (`animations`, default `true`).
- Command palette (`⌘K` / `Ctrl+K`) & `?` shortcuts sheet: fuzzy search (`ui/palette.js`) across chats, folders, actions (New task `⌘N`, New folder `⌘⇧N`, Open folder…, Settings, Usage, Model guide, Team picker `⌘T` / Team roles, model picker `⌘/`, toggle side panel `⌘\`, switch theme `⌘⇧L`, switch language, run tests on selected job, stop turn, shortcuts), and recent files opened in the side panel, plus a `?` modal listing all keyboard shortcuts.
- Read-only Roblox Studio playtest (`src/studiomcp.js`, `src/studioproxy.js`, `src/playtest.js`): signature-verified `StudioMCP` launcher (`codesign --verify --deep --strict` + Roblox TeamIdentifier/Identifier check, minimal environment), studio-owned stdio MCP proxy exposing only allowlisted read/play/input tools and blocking place edits/uploads/Luau execution, per-playtest caps (40 calls, 25 screenshots, 10 minutes), UI stop flag (`POST /api/playtest/<id>/stop`), screenshot storage under `.tokenwise-studio/playtests/<id>/` with base64 scrubbing from disk logs, data-only prompt injection defense for game output/screenshots, read-only `playtest` worker role (Claude Sonnet default, Settings → Roblox configuration & status, composer attach menu entry on Rojo projects), structured job-drawer report with Rojo-mapped console errors, thumbnails/lightbox, and "Ask to fix" action.
- Free, local, and Gemini orchestrators, full orchestrator fallback chain, and Free mode (`src/orchestrator.js`, `src/freeagent.js`, `src/mcp.js`, `src/antigravity.js`, `src/cli.js`, `src/settings.js`): in-process `"free"` and `"local"` (Ollama) orchestrator runners with read-only repo tools (`list_dir`, `read_file`, `search`) and shared in-process orchestrator tools (`delegate`, `job_wait`, `job_status`, `job_diff`, `job_merge`, `job_discard`, `job_test`, `project_map`, no write/edit tools) plus compact running chat history; Gemini orchestrator via Antigravity (`agy -p --mode plan`, enabled by default, registered in `tokenwise-studio setup` with `--no-gemini` skip and removed in `uninstall` or when toggled off in Settings); reorderable orchestrator fallback chain `claude → codex → gemini → free → local` honoring `on limit: automatic / ask me / off`, cooldowns, and pacing; and "Free mode — no plan usage" toggle in Settings and the composer model picker (with "Free" badge and TB 4.0 note) that forces orchestrator and all worker roles to free/local and refuses paid delegations.
- Signed and notarized Mac DMG (`scripts/build-dmg.sh`) with a bundled universal Node runtime, Developer ID signing, hardened runtime and stapled notarization, plus Sparkle automatic updates (daily check, **Check for Updates…** menu item, EdDSA-signed `docs/appcast.xml` served at https://tokenwise.site/appcast.xml).
- Windows desktop beta (`scripts/build-windows.sh`): unsigned WinForms/WebView2 app with bundled Node, per-project windows and server reuse. Not yet tested on real hardware.
- One-line installers: `https://tokenwise.site/install.sh` (Mac) and `install.ps1` (Windows), plus `scripts/release.sh` for publishing.
- Site refresh: Download for Mac / Windows buttons, 2x screenshots, v0.10 feature sections.

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
