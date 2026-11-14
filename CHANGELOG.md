# Changelog

## 0.6.0 (unreleased)

- Chat export and backup: export a chat as Markdown or JSON from its ... menu, `tokenwise-studio export [--chat <id>] [--out <dir>]` for the command line, and a "Back up all chats" button in Settings that copies chats, jobs and their images to `~/.tokenwise-studio/backups/<project>/<timestamp>/`.
- Project instructions: a `TOKENWISE.md` in the project root (or `.tokenwise-studio/instructions.md`) is added to the orchestrator's guide every turn, and its "## For workers" section goes to workers. Edit it from Settings. It cannot override the review and plan-only rules.
- Turn budget: an optional token budget per turn (50k to 500k) covering the orchestrator and its workers. A notice appears at 80%; at 100% the orchestrator can no longer start new jobs and wraps up. The turn footer now shows the turn's total tokens.

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
