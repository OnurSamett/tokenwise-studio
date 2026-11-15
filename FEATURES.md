# tokenwise and tokenwise studio: feature notes

*Living document — updated with every release.*

A NolienLabs project. Landing page: https://tokenwise.site

Version 0.10.1: verified commit-pinned updates, hardened Windows tool resolution, local-origin and frame protections, confirmed project test commands with secrets stripped, and bounded free-model streaming. Free models use measured latency, display their model label, and separate reasoning from answers. Mac apps require macOS 13.3+.

## 1. Pitch and problem

**tokenwise** is a skill for Claude Code, Codex CLI and Gemini CLI. For each piece of a large task it picks the model (Claude Haiku, Sonnet or Opus) and the reasoning effort separately, and hands mechanical work to cheaper subagents. **tokenwise studio** is its companion app: Claude Opus plans and reviews, while workers (Codex, Claude, Gemini, free hosted models, local Ollama) do the work in isolated git worktrees. You watch it all in a live UI and approve every change file by file.

**The problem.** Plan limits run out in the middle of real work, and a large share of the usage goes to work that never needed the most expensive model: grepping a repo, reading logs, writing boilerplate. The opposite mistake also costs: a hard bug sent to a small model at low effort wastes the run. Model choice and effort are two separate decisions, and most tools make neither.

## 2. Highlights

1. **Model and effort chosen separately, per piece of work.** Opus/low for a quick design check, Sonnet/high for a big routine refactor. Effort rises one step per signal: many interacting parts, ambiguity, a prior failure, a costly mistake.
2. **Orchestrator plus workers.** Opus plans and reviews. Workers run in their own git worktrees, and the orchestrator cannot edit your files itself.
3. **Nothing lands without review.** Per-file diffs with checkboxes. Changes are staged, never committed for you.
4. **Never stuck on a limit.** Worker fallback chain `codex → gemini → claude → free → local`, triggered at 90% of a plan limit (adjustable, 50–100%). The orchestrator itself falls back along `claude → codex → gemini → free → local`.
5. **Five kinds of worker.** Codex, Claude, Gemini (via Antigravity), free NVIDIA models, and local Ollama, which is free and unlimited.
6. **Benchmark-led model guide.** Free models are ranked by Terminal-Bench 4.0 of the version actually served. DeepSeek V4.1 Flash (40.0) ties Claude Haiku 5.5 (40.0).
7. **A native Mac app.** One window per project, Dock icon, desktop notifications, `tokenwise-studio://` links.
8. **It built itself.** The studio was built with tokenwise: the main Claude session only orchestrated, and Sonnet, Haiku, Opus, Codex and Gemini did the work.

## 3. Features

### Routing and limits
- **Per-piece model and effort routing (skill).** Haiku for search and logs, Sonnet for implementation, Opus for design and unknown bugs. Why: Opus is spent only where it changes the result.
- **Does not over-delegate.** Small tasks (about 10 tool calls or fewer) stay inline. Why: subagents start cold, so tiny delegations cost more than they save.
- **External workers.** Codex for images, Gemini via Antigravity, free NVIDIA models, local Ollama. Why: you use every plan you already pay for.
- **Three hosts.** Works in Claude Code, Codex CLI and Gemini CLI. Why: any agent can hand work to the others.
- **Live plan limits.** Claude and Codex 5-hour and weekly usage shown in the sidebar; readings from before a reset are ignored. Why: routing uses current numbers, not stale ones.
- **Worker fallback chain.** Pre-start skip of plans at the threshold, plus a re-run on the next worker after a rate-limit error. Why: a run finishes even when one plan is exhausted.
- **Orchestrator fallback and Free mode.** Orchestrator fallback chain `claude → codex → gemini → free → local` (reorderable in Settings, honoring `automatic` / `ask me` / `off`, cooldowns, and pacing). Gemini orchestrates through Antigravity (on by default; registered via `agy mcp add` in `setup` and toggled in Settings). Free and local (Ollama) orchestrators run an in-process tool loop with read-only repo tools and delegation/review tools, keeping a compact running chat history. **Free mode** ("Free mode — no plan usage" in Settings and the model picker) forces the orchestrator and every worker role to free/local and refuses delegations to paid agents. Why: the chat continues even when paid plans are exhausted or when you want zero plan usage.

### Orchestration and review
- **Isolated worktrees.** Each write job works on its own branch from `HEAD`. Why: parallel workers cannot collide, and your tree stays untouched.
- **Team cards.** Each worker shows agent, model, effort and live progress. Why: you see who is doing what.
- **Per-file review, apply, commit.** Why: you decide what enters the project.
- **Team panel and composer picker.** Auto, or pick agent, model and effort per role (code, quick work, reviews, images, research); presets quality, balanced, cheap, and free. Open the Team popover directly from the composer to see TB 4.0 scores, cost hints, plan-limit bars, and a one-line "why", and apply changes to the project or for one message only. Why: control when you want it, defaults when you do not.
- **Composer model picker.** Compact orchestrator button next to Send (⌘/) with Claude (Opus/Sonnet/Haiku), Codex (Sol/Terra/Luna), Gemini (Hydrogen/Argon), Free, and Local orchestrators, effort sub-choice (low/medium/high/xhigh), fast mode toggle, **Free mode — no plan usage** toggle with a "Free" badge and benchmark note (`TB 4.0 ≈ 40 vs Opus 5.5 64.8`), and live plan-limit switch hints. Why: the most-used choice is one click away.
- **Per-message `@mentions` routing.** Type `@` in the composer for `@codex`, `@claude`, `@gemini`, `@free`, `@local`, or models (`@sol`, `@terra`, `@luna`, `@opus`, `@sonnet`, `@haiku`, `@hydrogen`, `@argon`); validated server-side and injected into the orchestrator guide for that message only. Why: steer a single turn without changing project team settings.
- **Research role.** Read-only web search on Claude and Codex, with numbered citations and a Sources list. Why: answers you can check.
- **Test runner.** Per-project test command, a Run tests button per job, optional run before Apply, and a `job_test` tool for the orchestrator. Why: pass or fail sits next to the diff.
- **Undo Apply.** A git snapshot before every Apply; Undo restores only the files it touched and refuses if they changed since. Why: applying is never a one-way door, and your own edits are never lost.
- **Combined check.** Tests plus optional lint on the applied result, run without a shell and with a timeout. Why: two workers' changes can pass alone and fail together.
- **Roblox Studio error import.** Paste Studio Output; errors and stacks are deduplicated and mapped to files through Rojo, then sent to the orchestrator. Why: the loop from a playtest error to a fix is one paste.
- **Conflict check before Apply.** Overlapping edits from different workers are flagged before anything is staged. Why: you find out about a clash before it reaches your tree.
- **Open a pull request.** After Apply, a confirm step in the review drawer commits to a new branch, pushes and opens the PR with `gh` (or gives a compare link). It is a UI action only, never an orchestrator tool. Why: shipping is one step, and only you trigger it.
- **Model shootout.** On request, the same task goes to two or three models as parallel write jobs and you compare the results side by side. Only allowed when you ask for it in that turn, because it multiplies token use. Why: pick the best answer instead of trusting one model.
- **Quota pacing and provider cooldowns.** Reset times are parsed from limit errors, a provider in cooldown is skipped until it resets, and pacing settings spread usage across the window. Why: no worker is started just to fail on a known limit.
- **Rojo-aware project map.** For Roblox projects, a cached map of scripts and project files is given to the orchestrator and workers as a `project_map` tool and slices. Why: less exploring, fewer wasted tokens.
- **Permission modes.** `ask`, `auto-apply`, `plan-only`, enforced inside the MCP tools. Why: the rule holds even if the model ignores a prompt.
- **Per-turn token budget.** 50k–500k covering orchestrator and workers; a notice at 80%, no new jobs at 100%. Why: a runaway turn cannot drain a plan.

### Models and benchmarks
- **Free-model probe and fallbacks.** Free hosted models are probed with a tiny request; a model that is down is skipped for a few hours and the next ranked one is used. Free models are ranked for tool use. Why: a dead free model does not stall a run.
- **Codex orchestrator choices.** Pick the Codex model for the orchestrator when Claude is not in use. Why: the same choice logic on both sides.
- **Model guide.** Strengths per model, plus a benchmarks table led by the official Terminal-Bench 4.0 board. Why: choose with data, not brand names.
- **Free models ranked by TB 4.0 of the served version.** Why: vendor numbers on older benchmarks can mislead (see section 5).
- **Ladders per agent.** Fast, balanced and frontier models for Codex, Claude, Gemini and free NVIDIA. Why: the same choice logic everywhere.
- **Fast mode.** Optional, for Claude and Codex. Why: speed when you need it.

### The Mac app
- **Native window** (Swift, WKWebView): one window per project, Dock icon, ⌘O, Open Recent, `tokenwise-studio://` URL scheme. Why: it behaves like an app, not a browser tab.
- **Desktop notifications.** Ready for review, finished, failed, one per orchestrator turn, and a Codex takeover. Clicking opens that project's window. Why: you can leave long runs alone.
- **Open folder in the app, and a lighter UI.** Choose a project from the app itself.
- **Restore and welcome window.** The app reopens your last projects; with none, a welcome window lists recent projects instead of a folder dialog. Why: you land where you left off.
- **App-only notifications.** Notifications come only from the tokenwise studio app (no script fallback), with one limit notice per window. Why: quieter, and clicks open the right project.
- **Downloads** go to `~/Downloads` without overwriting files, and the file is shown in Finder. Why: exports work in the app window.
- **Servers outlive the window.** Why: terminal and app share the same state.
- **Stale-server protection.** Each server reports the version it started with; the app replaces a server from an older version, shows a clear banner if a page cannot load, and restarts a vanished server once. Why: an upgrade never leaves a dead window.

### Chat and workflow
- **Chat folders, pinning and date groups.** Create, rename, pin, collapse and delete per-project folders (stored in `.tokenwise-studio/folders.json`; deleting a folder keeps its chats unfiled). Drag chats into folders or use "Move to folder" in the chat menu for keyboard navigation, with Today, Yesterday, Previous 7 days and Older date groups inside each folder and for unfiled chats. Why: long-lived projects stay organised without hiding active tasks.
- **Command palette and shortcuts sheet.** Press `⌘K` (`Ctrl+K` elsewhere) for fuzzy search over chats, folders, actions and recent files from the side panel, or `?` for a full keyboard-shortcuts sheet. Why: jump anywhere or trigger actions without leaving the keyboard.
- **Effort-aware working animations.** Running turns scale indicator motion and worker card progress speed with turn/worker effort (`low` through `xhigh`), paired with a sticky "Working · Stop" banner at the top of the chat, `prefers-reduced-motion` support, and a Settings toggle (`animations`). Why: clear live progress cues without visual noise.
- **Rojo project map and Studio error import.** Builds a compact Rojo-aware project map (`project_map`), imports Studio Output logs with Rojo file:line stack mapping, and runs read-only playtests directly through Roblox Studio's `StudioMCP` (`src/studiomcp.js`, `src/studioproxy.js`, `src/playtest.js`). Why: debug and verify Roblox experiences without letting any worker edit the `.rbxl` outside Rojo.
- **Playtest worker & Safety.** Before launch, `StudioMCP`'s macOS code signature and Roblox Team ID are verified and secrets are stripped from its environment; a studio-owned MCP proxy exposes only an explicit allowlist of play/read/input tools (blocking `multi_edit`, `save_place`, `insert_asset`, `upload_image`, `generate_*`, and `execute_luau`), enforces call/screenshot/time caps (40 calls / 25 shots / 10 min) plus a live UI stop button, stores screenshots separately with base64 scrubbed from logs, treats all console/screen output strictly as untrusted data, and presents a structured report with thumbnails and "Ask to fix".
- **Workspace side panel.** Project files, diffs, image and page previews, and a "This chat" tab with the files touched in the current chat. Paths are confined to the project and secret files are blocked. Why: look around without leaving the studio.
- **Dictation.** A microphone button in the composer (Mac app, macOS speech recognition). Why: talk instead of typing long briefs.
- **Compaction fix.** Compaction no longer repeats on every turn, and non-git folders offer a one-click git setup. Why: long chats and new projects just work.
- **Images in chat.** Paste, drag or attach; forwarded to Claude and Codex workers. Why: show a bug instead of describing it.
- **Generated images inline.** Thumbnails, lightbox, applied like any file. Why: icons and banners go through the same review.
- **Collapsible thinking steps.** Why: a calm transcript with the reasoning one click away.
- **Compaction.** Past a threshold (default 120k tokens), a Haiku summary starts a fresh session; the full history stays visible. Why: long chats stay affordable.
- **Chat export and backups.** Markdown or JSON, `tokenwise-studio export`, backup of all chats. Why: nothing is lost with a browser or app window.
- **Project instructions** (`TOKENWISE.md`), with a section for workers. Why: rules are written once; they cannot override review or plan-only.
- **Usage screen.** Tokens and API-equivalent cost by day (14 days), agent and model. Why: you see where usage goes.
- **Turkish UI.** English, Türkçe or Auto, also for notifications.

### Safety
- **Reviewed changes only.** Workers write to their worktree; you apply.
- **Free-model tool loop.** Read, search, edit and allowlisted tests; no arbitrary commands; paths confined to the worktree, with symlinks, `.git` and secret files blocked. Free hosted models are used only after you opt in, because free tiers may train on prompts.
- **Local-only server.** Binds to `127.0.0.1`, with CSRF and Host checks.
- **Upload validation** (PNG, JPEG, WebP, GIF; size and count caps) and **sandboxed workers** (Gemini write jobs run commands only inside Antigravity's terminal sandbox).
- **`max` and `ultra` effort are refused**; Codex astra is blocked unless enabled.

### Install and updates
- **Signed, notarized Mac DMG** with bundled Node (Apple Silicon and Intel), **Sparkle updates** (daily check, Check for Updates… menu, signed appcast at tokenwise.site), and **one-line installers** (`install.sh`, `install.ps1`).
- **Windows desktop beta:** unsigned WebView2 app with bundled Node, one window per project. Untested on real hardware; dictation, Roblox playtest and Sparkle are Mac-only.
- `npm install -g github:OnurSamett/tokenwise-studio`, then `tokenwise-studio setup` registers the MCP server with Claude Code and Antigravity (`--no-gemini` skips Antigravity) and builds the Mac app. `--dry-run` shows the plan first.
- `doctor` shows which workers are ready and how to fix the rest; `uninstall` removes everything.
- **Automatic updates** (default): the studio installs new versions in the background, at most once a day, never while work is running and never over a git checkout; you press Restart now when it suits you. Modes: Automatic, Notify only, Off.
- `update` reinstalls, rebuilds the app and stops running studio servers so windows reload on the new version.

## 4. Demo scripts

### 5-minute walkthrough
1. **(0:00)** Open the Mac app, pick a project. Point out the sidebar: plan limits and the orchestrator card.
2. **(0:30)** Open the model guide and the benchmarks table. Show that free models are ranked by TB 4.0.
3. **(1:00)** Open the Team panel: Auto, then the cheap preset. Show per-role choices.
4. **(1:30)** Paste a screenshot of a bug and ask: "Fix this. Delegate independent fixes as write jobs."
5. **(2:00)** Watch the team cards fill in: different agents, models, efforts. Expand a Thinking section.
6. **(3:00)** Open the review drawer. Untick one file, press Run tests, then Apply. Show that it is staged, not committed.
7. **(3:45)** Ask for an icon. Show the generated image inline and apply it.
8. **(4:15)** Open Settings: permission modes, on-limit switch, threshold. Show the Usage screen.
9. **(4:45)** Show a notification arriving and clicking it. Close with the fallback story: when Claude runs out, Codex Sol takes over.

### 30-second version
1. Ask for a change; the team cards show three workers with different models.
2. Open the review drawer, run tests, Apply.
3. Point at the sidebar limits and say: when a plan fills up, the work moves to the next worker by itself.

## 5. Numbers worth quoting

Source for all benchmark numbers: Terminal-Bench 4.0 leaderboard, https://hub.harborframework.com/datasets/terminal-bench/terminal-bench/4?tab=leaderboard&leaderboard=4-0-0

| Fact | Number |
|---|---|
| DeepSeek V4.1 Flash (free) vs Claude Haiku 5.5, TB 4.0 | 40.0 vs 40.0, a tie at no cost |
| GPT-6.1 Sol vs GPT-6 Astra, TB 4.0 | 58.2 for both, at about 1/5 the cost |
| Kimi K3, vendor TB 2.1 claim vs TB 4.0 | 88.3 vs 22.4 |
| Fallback trigger (default) | 90% of a 5-hour or weekly limit; adjustable 50–100% |
| Compaction threshold (default) | 120k tokens; adjustable 60k–400k |
| Turn budget range | 50k–500k tokens; notice at 80% |
| Worker types | 5 (Codex, Claude, Gemini, free hosted, local) |
| Fallback order | codex → gemini → claude → free → local |

Use the Kimi K3 line as a caution: always compare models on the same, current benchmark. Cost figures in the Usage screen are API-equivalent, not what a subscription charges; Claude Code reports its own cost and other prices are rough estimates.

## 6. Built with tokenwise

The studio was built with tokenwise. The main Claude session acted only as orchestrator: it planned, wrote briefs and reviewed. The work itself was done by Sonnet, Haiku and Opus subagents, each with its own effort. When Claude limits ran out, Codex and Gemini took over, and the same fallback chain that ships in the product kept the work going. The Mac launcher design, logo and first UI mockup were also generated through Codex. The tool was its own first user, and many of the review, fallback and notification features come from problems met while building it.

## 7. Coming next

**Planned (design documents, not built)**
- **Roblox game workflow:** a game profile in the repo, a sandboxed step runner for format, lint, type and unit checks, Blender-generated 3D with rendered previews, one reviewable bundle per feature, upload as a UI button only (never an MCP tool).
- **Computer control through Roblox Studio's MCP:** StudioMCP playtesting (read-only, signature-verified, allowlisted, capped, stoppable) is now shipped; desktop browser/app visual verification flows remain planned.
- **Mobile access:** an opt-in remote view of the existing UI over Tailscale, with pairing by QR code, device revocation and read-only by default. Not a native app, and never exposed to the public internet.

**Later, from the roadmap:** session replay, multi-project queue, Linux, chat search.

## 8. Version history

- **0.1:** MCP delegate tools, worktree jobs, live web UI, orchestrator chat, per-file review.
- **0.2:** Polished UI, commit flow, cost per task, project picker, light theme, CSRF and DNS-rebinding protection, Gemini workers via Antigravity, automatic fallback chain, free and local workers.
- **0.3:** `setup`, `doctor`, `uninstall`, Mac launcher app.
- **0.4:** Native Mac window, desktop notifications, Codex orchestrator fallback, Terminal-Bench 4.0 ranking, sidebar orchestrator card, `update` command.
- **0.5:** Images in chat, thinking steps, Settings panel with permission modes.
- **0.6:** Chat export and backup, project instructions, turn budget, Usage screen, inline generated images, test runner.
- **0.7:** Turkish UI, chat compaction, research role with citations.
- **0.8:** Undo Apply, combined check after Apply, Roblox Output error import, automatic updates, stale-server protection, worker fixes.
- **0.9:** Workspace side panel, pull requests from the review drawer, conflict check, dictation, model shootout, quota pacing and cooldowns, free-model probe, Rojo project map, welcome window and restore, app-only notifications.
- **0.10:** Composer model + effort picker with live limit hints, composer Team picker popover with per-message overrides and Free preset, `@mentions` per-message worker routing, sidebar chat folders with date groups and pinning, effort-aware working animations with a sticky Stop banner and Settings toggle, `⌘K` command palette with `?` shortcuts sheet, read-only, signature-verified Roblox Studio MCP playtesting, and orchestrator fallback beyond Claude/Codex (`claude → codex → gemini → free → local`) with Free/local in-process orchestrators, Gemini orchestrator via Antigravity, and Free mode. Signed notarized DMG with Sparkle updates, Windows beta app, installers, site refresh.
