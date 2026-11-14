// Compaction of long orchestrator chats: threshold detection, Claude Haiku summarization,
// deterministic fallback from stored turns + job list, and output capping.
import { spawn } from "node:child_process";
import { available } from "./fallback.js";
import { scrub } from "./export.js";

export const COMPACT_MIN = 60_000;
export const COMPACT_MAX = 400_000;
export const COMPACT_DEFAULT = 120_000;
export const COMPACT_NOTICE = "Earlier conversation compacted to save tokens";
export const SUMMARY_MAX_CHARS = 3500;
export const INPUT_MAX_CHARS = 24_000;

const clip = (s, n) => {
  const str = String(s || "").trim();
  return str.length > n ? str.slice(0, n - 1).trimEnd() + "…" : str;
};

/** Orchestrator context tokens for one completed turn. */
export function contextTokens(turn) {
  const t = turn?.tokens;
  if (!t || typeof t !== "object") return 0;
  const input = Number(t.input) || 0;
  const cached = Number(t.cached) || 0;
  const output = Number(t.output) || 0;
  // Codex includes cached_input_tokens inside input_tokens; Claude reports cache_read_input_tokens separately.
  if ((turn.agent || "claude") === "codex") return Math.max(input, cached) + output;
  return input + cached + output;
}

/** Context tokens of the most recent turn with usage since the last compaction (or 0). */
export function lastContextTokens(chat) {
  if (!chat || !Array.isArray(chat.turns) || !chat.turns.length) return 0;
  const start = chat.compaction?.throughTurn || 0;
  const recent = chat.turns.slice(start);
  const last = [...recent].reverse().find((t) => t && t.tokens);
  return last ? contextTokens(last) : 0;
}

/** Pure decision: should the chat be compacted before starting the next turn? */
export function shouldCompact(chat, settings) {
  if (!settings?.compactChats) return false;
  if (!chat || !Array.isArray(chat.turns) || chat.turns.length === 0) return false;
  const start = chat.compaction?.throughTurn || 0;
  if (start >= chat.turns.length) return false;
  const tokens = lastContextTokens(chat);
  if (!(tokens > 0)) return false;
  const threshold = Number(settings.compactThreshold) || COMPACT_DEFAULT;
  return tokens > threshold;
}

/** Trim and cap summary text cleanly at a line or word boundary. */
export function capSummary(text, max = SUMMARY_MAX_CHARS) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const nl = slice.lastIndexOf("\n");
  const cut = nl > max * 0.6 ? slice.slice(0, nl) : slice;
  return cut.trimEnd() + "…";
}

function summarizeJobs(chatJobs = [], max = 30) {
  const list = chatJobs.slice(-max);
  if (!list.length) return [];
  return list.map((j) => {
    const mode = j.write ? "write" : "read-only";
    const files = j.status === "merged" && j.applied?.length ? j.applied : j.files || [];
    const fileNote = files.length
      ? ` [${j.status === "merged" ? "applied" : "files"}: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}]`
      : "";
    const res = j.final ? ` — ${clip(j.final.replace(/\s+/g, " "), 200)}` : "";
    return `- [${j.status || "unknown"}] ${j.agent || "worker"}${j.model ? ` ${j.model}` : ""} (${mode}): ${clip(j.title, 120)}${fileNote}${res}`;
  });
}

/** Build the strict prompt for Claude Haiku to summarize a chat. */
export function buildSummaryPrompt(chat, chatJobs = []) {
  const start = chat?.compaction?.throughTurn || 0;
  const turns = (chat?.turns || []).slice(start);
  const parts = [];
  if (chat?.compaction?.summary) {
    parts.push(`Previous compacted summary:\n${clip(chat.compaction.summary, 3500)}`);
  }

  const turnBlocks = turns.map((t, idx) => {
    const n = start + idx + 1;
    const who = t.agent || "claude";
    return `Turn ${n} (${who}):\nUser: ${clip(scrub(t.user), 1200)}\nAssistant: ${t.reply ? clip(scrub(t.reply), 2000) : "(no reply)"}`;
  });

  // Keep the most recent turns within INPUT_MAX_CHARS so Haiku stays cheap and fast.
  let transcript = "";
  for (let i = turnBlocks.length - 1; i >= 0; i--) {
    if (transcript.length + turnBlocks[i].length > INPUT_MAX_CHARS && transcript) break;
    transcript = turnBlocks[i] + (transcript ? "\n\n" : "") + transcript;
  }
  if (transcript) parts.push(`Conversation turns:\n${transcript}`);

  const jobLines = summarizeJobs(chatJobs);
  if (jobLines.length) parts.push(`Worker jobs:\n${jobLines.join("\n")}`);

  return [
    "Summarize this orchestrator coding conversation so a fresh session can continue seamlessly.",
    "Be concise and factual. Do not invent files, symbols, or decisions not present below.",
    "Output ONLY markdown with these exact 5 headings, staying under 2500 characters total:",
    "",
    "## Goal",
    "- ...",
    "## Decisions",
    "- ...",
    "## Files touched",
    "- ...",
    "## Jobs and status",
    "- ...",
    "## Open questions",
    "- ...",
    "",
    `Chat title: ${clip(chat?.title || "Untitled", 120)}`,
    "",
    parts.join("\n\n"),
  ].join("\n");
}

/** Build a deterministic summary from stored turn replies and the job list when Haiku is unavailable. */
export function deterministicSummary(chat, chatJobs = []) {
  const turns = chat?.turns || [];
  const start = chat?.compaction?.throughTurn || 0;
  const recent = turns.slice(start);
  const firstUser = turns[0]?.user ? clip(turns[0].user.replace(/\s+/g, " "), 300) : "";
  const title = clip(chat?.title || "Untitled task", 120);

  const goalLines = [`- Task: ${title}`];
  if (firstUser && firstUser !== title) goalLines.push(`- Initial request: ${firstUser}`);
  if (chat?.compaction?.summary) {
    goalLines.push(`- Prior summary carried forward:\n${clip(chat.compaction.summary, 900)}`);
  }

  const decisionLines = [];
  for (const t of recent.slice(-6)) {
    const reply = String(t.reply || "").trim();
    const user = clip(String(t.user || "").replace(/\s+/g, " "), 140);
    if (reply) {
      decisionLines.push(`- (${user || "turn"}) ${clip(reply.replace(/\s+/g, " "), 320)}`);
    } else if (user) {
      decisionLines.push(`- (${user}) (no reply recorded)`);
    }
  }
  if (!decisionLines.length) decisionLines.push("- No prior replies recorded.");

  const appliedFiles = new Set();
  const pendingFiles = new Set();
  for (const j of chatJobs) {
    if (j.status === "merged") {
      for (const f of j.applied?.length ? j.applied : j.files || []) appliedFiles.add(f);
    } else if (j.status !== "discarded" && j.status !== "moved") {
      for (const f of j.files || []) pendingFiles.add(f);
    }
  }
  const fileLines = [];
  for (const f of [...appliedFiles].slice(0, 20)) fileLines.push(`- \`${f}\` (applied)`);
  for (const f of [...pendingFiles].slice(0, 20)) {
    if (!appliedFiles.has(f)) fileLines.push(`- \`${f}\` (pending review/unapplied)`);
  }
  if (!fileLines.length) fileLines.push("- None recorded.");

  const jobLines = summarizeJobs(chatJobs, 20);
  if (!jobLines.length) jobLines.push("- No worker jobs run.");

  const openLines = [];
  const readyWrite = chatJobs.filter((j) => j.write && j.status === "done" && (j.files || []).length);
  const runningJobs = chatJobs.filter((j) => j.status === "running");
  const failedJobs = chatJobs.filter((j) => j.status === "failed");
  if (readyWrite.length) openLines.push(`- ${readyWrite.length} write job(s) ready for review/apply.`);
  if (runningJobs.length) openLines.push(`- ${runningJobs.length} worker job(s) still running.`);
  if (failedJobs.length) openLines.push(`- ${failedJobs.length} failed job(s): ${failedJobs.slice(-3).map((j) => clip(j.title, 60)).join("; ")}.`);
  const lastTurn = recent.at(-1) || turns.at(-1);
  if (lastTurn && !lastTurn.reply) openLines.push("- Last turn ended without an assistant reply.");
  if (!openLines.length) openLines.push("- Continue from the user's next message.");

  return capSummary([
    "## Goal",
    ...goalLines,
    "## Decisions",
    ...decisionLines,
    "## Files touched",
    ...fileLines,
    "## Jobs and status",
    ...jobLines,
    "## Open questions",
    ...openLines,
  ].join("\n"));
}

/** Default Claude Haiku headless runner (`claude -p --model haiku`). */
export function defaultHaikuRunner({ prompt, repo, home, timeoutMs = 45_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("compaction aborted");
      err.name = "AbortError";
      return reject(err);
    }
    if (home && !available("claude", { write: false }, home)) {
      return reject(new Error("claude is not available"));
    }
    const args = ["-p", prompt, "--model", "haiku", "--tools", "", "--no-session-persistence", "--output-format", "text"];
    const child = spawn("claude", args, { cwd: repo || process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(val);
    };
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch {}
      const err = new Error("compaction aborted");
      err.name = "AbortError";
      finish(reject, err);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(reject, new Error("haiku compaction timed out"));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      if (out.length < SUMMARY_MAX_CHARS * 4) out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (errText.length < 2000) errText += chunk.toString();
    });
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (code === 0 && out.trim()) return finish(resolve, out.trim());
      finish(reject, new Error(errText.trim() || `claude haiku exited (${code})`));
    });
  });
}

/** Produce a compact summary via Haiku (if available) or deterministic fallback. */
export async function compactChat({ chat, jobs = [], runner, repo, home, timeoutMs, signal } = {}) {
  const prompt = buildSummaryPrompt(chat, jobs);
  const run = runner || defaultHaikuRunner;
  try {
    const raw = await run({ prompt, repo, home, timeoutMs, signal });
    const capped = capSummary(raw);
    if (capped) return { summary: capped, method: "haiku" };
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) throw err;
  }
  return { summary: deterministicSummary(chat, jobs), method: "deterministic" };
}
