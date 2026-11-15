# Landing page audit — 2026-11-15

Compared with README.md, FEATURES.md, CHANGELOG.md (0.9.0 and unreleased 0.10.0), current UI source, and all seven existing product JPEGs. This is a source and asset audit; browser rendering could not run in the restricted environment.

| Finding | Change / status |
| --- | --- |
| Title, description and navigation called the app `tokenwise`, which is also the companion skill. | Standardized the app to `tokenwise studio`; retained `tokenwise` for the skill. |
| Unreleased composer pickers, mentions, folders and command palette appeared alongside 0.9.0 features without a release distinction. | Added a visible 0.9.0 / upcoming 0.10.0 note and changelog link. |
| The hero image's 800px intrinsic width left part of its 1040px frame empty. | Made the image fill its frame. Native dimensions remain truthful until new captures exist. |
| The hero install command was explicitly truncated with ellipsis on narrow screens. | Allowed wrapping and word breaks, keeping the whole command visible. |
| Absolute Copy buttons occupied the same space as the first installation command. | Reserved a separate top row for each Copy button; wrapped long code lines. |
| `overflow-x: clip` concealed rather than exposed potential document overflow. | Removed masking. The capture script checks document width and element bounds at 390px. Actual phone rendering remains pending. |
| Sticky navigation could cover anchor headings; keyboard navigation had no explicit focus treatment or skip link. | Added anchor offsets, indigo focus outlines, a skip link, a main landmark and a navigation label. |
| Gallery images could not be opened at their native size. | Linked every product image to its full file. |
| Copy described every piece of work as a worktree job. | Specified writing workers; read-only orchestration/research do not require this claim. |
| Fallback copy only described Claude → Codex and implied a fixed 90% threshold. | Documented the configurable threshold, complete orchestrator chain and Settings modes, separately from worker fallback. |
| Free mode was missing, and local workers were described as unlimited. | Added free/local orchestration and tied local execution to the user's hardware. |
| Benchmark results were presented as a current board ranking and compared different benchmark versions. | Labeled values as the repository's 0.9.0 snapshot; removed the cross-version comparison and current-leader claim. External results were not independently verified. |
| FAQ claimed a published savings benchmark harness without a corresponding reference. | Replaced the claim with the actual Model guide and Usage features; clarified API-equivalent cost versus subscription billing. |
| FAQ promised that providers never receive secrets. | Clarified file-tool restrictions and that pasted prompt text is sent to the chosen provider. Added Settings-based free-provider opt-in. |
| Installation copy omitted Gemini CLI's API-key option and suggested other platforms were supported/tested. | Added the API-key option and stated only macOS is tested; broadened the setup comment to CLI MCP registration. |
| Social preview used a yellow, skill-branded graphic inconsistent with the graphite/indigo app page. | Switched Open Graph, Twitter and structured-data images to the app screenshot; added image descriptions. |
| All seven product JPEGs are only 800×514 and visibly soft. They show the previous composer, lack folders, mention chips, effort animation, palette and a visible turn budget. The light theme was absent from the landing gallery. | **Pending capture.** Prepared `/tmp/tw-capture.sh`; did not upscale or mislabel existing assets. The script captures 13 new views, adds the missing gallery entries, updates HTML dimensions to 1440×900, and replaces matching README assets. |
| Existing ready/review screenshots disagree internally: the assistant says two files while the review banner lists three. Old usage imagery clips the lower plan-limit section. | **Pending capture.** The new English demo has two jobs / three files, four plan-meter values, a finished 72k / 100k turn, daily usage and per-model cost. Capture includes both Tokens and Cost charts. |
| Possible generic project title / missing provider logo in the new UI. | Current source already reads `S.project.name` with a repo-basename fallback, and the model button calls `orchIcon`. No speculative UI edit made; the capture script asserts `web-app` and a loaded picker image. |
| Broken local images, links or anchors. | All 30 local `src` / `href` references passed the Node checker after changes. Six external targets initially failed DNS resolution, not HTTP validation; recheck is included in the capture script. |
| Typos or accidental mixed-language content. | No additional prose typos or mixed-language paragraphs found. `Türkçe` is the intentional language name in the English feature description. |

## Verification and limitations

- Python HTTP server on 4790: blocked by `PermissionError: Operation not permitted`.
- Isolated studio server on 4792: blocked by `listen EPERM`. Both failed before listening.
- Headless Chrome at desktop and phone sizes: exited 134 before producing any image. No before/after screenshots or browser assertions are claimed as passed.
- The demo seed was executed in a temporary HOME and temporary `web-app` git repo. Direct checks of the actual Jobs, Chats, limits, timeline and usage modules passed: Claude 37% / 52%, Codex 24% / 41%, two diffs, multiple daily usage readings and at least three model rows. Direct GET handler checks also passed for state, limits, usage, both review diffs, chat timeline, folders, orchestrator selection and Claude/Codex provider SVGs. No model was called.
- Capture/checker scripts pass `node --check`; shell capture script passes `bash -n`. The page's inline JavaScript also passes `node --check`.
- `npm test` retained its existing isolated HOME runner. First run: **159/160 passed**; existing `test/playtest.test.js:924` failed the `stoppedByUser` assertion. Second run: **158/160 passed**, with the same failure plus `test/shootout.test.js:266`. These tests execute no changed landing-page code. Tests are not green; application/test files were left outside this task's edit scope.
- No source-repository git write, commit or push. No server started successfully, so none remains to stop. The pre-existing listener on 4791 was left untouched.

## Deferred capture

Run `bash /tmp/tw-capture.sh` in a normal terminal. It is self-contained, checks three free ports in 4790–4799, creates a temporary HOME and browser profile, seeds only generic English content, and shadows provider CLIs with non-generating stubs. All servers it starts are stopped by an EXIT trap.

The script uses CDP for real picker clicks and screenshots, requires native 2880×1800 product captures, encodes JPEG at quality 90, checks a 400 KiB image limit before replacement, and captures full-page before/after views at 1440px and 390px. It fails if the fixed page has horizontal overflow, broken images or a browser exception. Inspect the resulting PNGs before considering visual QA complete. The baseline HTML is embedded in the script. Temporary scripts are intentionally outside the repository.
