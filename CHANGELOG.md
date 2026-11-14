# Changelog

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
