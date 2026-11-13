# 🪙 tokenwise studio

**One agent orchestrates, the others do the work.** Let Claude Opus plan and review while ChatGPT Codex **Sol**, Claude **Haiku/Sonnet** or **Gemini** do the hands-on work, each in its own git worktree, with a live web UI to watch and approve it all.

Companion to [tokenwise](https://github.com/OnurSamett/tokenwise): tokenwise decides *which* model should do a piece of work; studio gives the orchestrator a way to actually hand it to another agent and merge the result.

```
           ┌──────────────────────────────┐
           │  Orchestrator (Claude Opus)   │  plans, reviews, merges
           └──────────────┬───────────────┘
                 delegate │ (MCP tools)
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
 Codex sol·medium   Claude haiku·low    Gemini (Flash/Pro)
 worktree tw/…a1    read-only answer    worktree tw/…c3
       └───── job_diff → job_merge / job_discard ─────┘
```

## What it looks like

- **One calm conversation.** You describe a task; the orchestrator explains its plan and hands pieces to workers.
- **A team card per step**: each worker with its agent, model, effort and live progress.
- **"N files ready for review"**: one click opens a review drawer with per-file diffs and checkboxes. Nothing lands until you press *Apply* (changes are staged, not committed).
- **Plan limits in the sidebar**: your Claude and ChatGPT Codex 5-hour and weekly usage, read from the CLIs' own output.
- The orchestrator cannot edit files itself; every change comes from a worker you can review.

## Why

- **Spread usage across plans you already pay for.** Heavy thinking stays on Opus; mechanical edits run on your ChatGPT (Codex) or Google plan.
- **Safe by default.** Writing workers only ever touch their own git worktree. Nothing reaches your working tree until the orchestrator (or you, in the UI) applies the diff.
- **Watch it live.** Every job streams into the UI: agent, model · effort, status, output, and the diff.

## Requirements

- Node 20+, git
- At least one worker CLI, signed in: [Codex CLI](https://github.com/openai/codex) (`codex login`), [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) (`claude auth login`), Gemini via [Google Antigravity](https://antigravity.google) (`agy`, included in Gemini.app on macOS; run it once to sign in with your Google account; models `hydrogen` (fast, default) and `argon` (frontier)) or [Gemini CLI](https://github.com/google-gemini/gemini-cli) with `GEMINI_API_KEY` (Gemini CLI's own Google sign-in no longer works for individuals)

## Setup

The simplest start, from inside your project folder (opens the studio in your browser):

```bash
npx github:OnurSamett/tokenwise-studio
```

Or from a clone:

```bash
git clone https://github.com/OnurSamett/tokenwise-studio.git
cd tokenwise-studio && npm install
node src/cli.js /path/to/project   # options: --port N, --no-open
```

Register the MCP server with Claude Code (once, for all projects):

```bash
claude mcp add tokenwise-studio --scope user -- node "$PWD/src/mcp.js"
```

The server works on the project Claude Code is opened in. To start only the UI (no browser) for that project:

```bash
node /path/to/tokenwise-studio/src/ui.js /path/to/your/project
# → http://127.0.0.1:4777
```

## Use

Just ask your orchestrator, e.g. in Claude Code on Opus:

> Fix the failing tests. Delegate each independent fix to codex sol at medium effort as a write job, review the diffs, merge the good ones, then run the tests.

### MCP tools

| Tool | What it does |
|------|--------------|
| `delegate` | Start a job: `agent` (codex/claude/gemini), `model`, `effort`, `task`, `write` |
| `job_wait` | Wait for a job and get its answer + diff summary |
| `job_status` | List jobs or inspect one |
| `job_diff` | Full diff of a write job |
| `job_merge` | Apply a job's diff to your working tree (staged, not committed) and clean up |
| `job_discard` | Stop and throw away a job |

### When a plan runs out

Jobs fall back automatically along `codex → gemini → claude → free → local` (override with `TOKENWISE_FALLBACK`):

- **Before starting**, a job skips any plan at or above `TOKENWISE_LIMIT_THRESHOLD` (default 90%) of its 5-hour or weekly limit, or a worker that isn't signed in.
- **While running**, a job that fails with a rate/usage-limit error is re-run on the next worker; the UI shows "↪ took over from Codex · hit a rate limit", and `job_wait` follows the move.
- **local**: an Ollama model driven by Codex CLI's `--oss` mode: free, unlimited, full agent (`brew install ollama && ollama pull gpt-oss:20b`).
- **free**: free-tier hosted APIs, tried in order: NVIDIA (`NVIDIA_API_KEY` from build.nvidia.com), OpenRouter `:free`, Groq, Mistral, or any OpenAI-compatible endpoint (`TOKENWISE_FREE_BASE` + `TOKENWISE_FREE_KEY`). A rate limit on one moves to the next. Free models run inside studio's own small tool loop (`src/freeagent.js`), so they read the repo and, in write jobs, edit files in their worktree; they cannot run commands, and paths are confined to the worktree with symlinks, `.git` and secret files blocked. Used only after you opt in with `TOKENWISE_ALLOW_FREE=1`, since free tiers may use prompts for training.

### Defaults and guard rails

- Codex: `sol` at `medium` (families `terra`/`sol` resolve to the newest version automatically). `astra` is blocked unless `TOKENWISE_CODEX_ASTRA=1`.
- Claude: `haiku` at `low`. Gemini (Antigravity): `hydrogen` at `medium`; write jobs may run commands only inside Antigravity's terminal sandbox.
- `max`/`ultra` effort is refused.
- Write jobs branch from `HEAD`: uncommitted changes in your tree aren't visible to workers.
- The UI binds to `127.0.0.1` only. State lives in `.tokenwise-studio/` (git-excluded automatically).

## Status

Early (v0.1). Codex and Claude workers are tested end to end; Gemini is wired up but less tested. Issues and PRs welcome.

## License

MIT
