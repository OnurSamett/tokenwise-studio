# Security notes

Fixes from the November 2026 security review.

## Untrusted project state

A cloned repository can ship its own `.tokenwise-studio/` folder, so job and chat files in it are treated as untrusted data.

- **Undo** only restores from a `refs/tokenwise/pre-apply/*` snapshot ref. Before it writes anything, it checks every target path: no symlinked or non-directory parent, and the real path must stay inside the real project root. If any path fails, the whole Undo is refused.
- **Job records** whose id is not `[A-Za-z0-9_-]+`, or whose `applied`/`files` entries are not plain relative paths, are ignored when loading.
- **Discard and shootout pruning** only remove a worktree registered at `.tokenwise-studio/worktrees/<id>` and its own `tokenwise/<id>` branch. The branch is deleted with `git branch -d`; only an explicit Discard click force-deletes it.
- **Processes:** a PID from a job file is only signalled if it is still the process recorded at spawn (same start time and command).
- **Resumed sessions:** Codex thread ids and Claude session ids from chat files must look like ids. They are never passed where they could be read as a flag.

## Commands and environment

- **Tests:** `job_test` and the automatic "Run tests before Apply" only run the test command the user set under Settings > Tests. They never detect one from the worker's worktree. If that command is an `npm`/`pnpm`/`yarn`/`bun` script and the job changed `package.json`, they refuse. Test runs also drop every `*_TOKEN` variable, as well as API keys.
- **Worker environment:** workers get an allow-listed environment (PATH, HOME, locale, proxy/CA settings, non-secret `TOKENWISE_*` settings, and their own provider's variables). `GH_TOKEN`, `NPM_TOKEN` and other providers' keys are no longer passed.
- **Folder trust:** `gemini --skip-trust` and `cursor-agent --trust` are only passed for the worktree Studio itself created for a write job, never for the user's repository.
- **Ollama key (branch `remote-ollama-doctor`):** `OLLAMA_API_KEY` is only sent to `https://` or loopback gateways.

## Release builds

- **Windows:** the build publishes without debug symbols (`DebugType=none`, `PathMap`) and deletes any `.pdb` before zipping, so local build paths are not shipped.
