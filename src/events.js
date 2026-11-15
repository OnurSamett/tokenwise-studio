// Turn raw CLI output lines (Codex --json, Claude stream-json, Gemini stream-json) into a
// readable timeline: [{ kind, text, detail? }]
// kinds: say | think | cmd | edit | read | search | delegate | tool | usage | done | error | meta | notice | handoff | compact
import { COMPACT_NOTICE } from "./compact.js";

const short = (s, n = 300) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Make worker paths readable: strip the worktree / repo prefix. */
export function rel(p, base) {
  if (!p) return p;
  const wt = p.match(/\.tokenwise-studio\/worktrees\/[^/]+\/(.*)$/);
  if (wt) return wt[1];
  if (base && p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p;
}

function codex(e, base) {
  const it = e.item || {};
  if (e.type === "item.completed") {
    if (it.type === "agent_message") return [{ kind: "say", text: it.text }];
    if (it.type === "reasoning") return [{ kind: "think", text: it.text }];
    if (it.type === "command_execution") {
      const cmd = String(it.command || "").replace(/^\/bin\/(z|ba)?sh -lc /, "").replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
      return [{ kind: "cmd", text: short(cmd, 200), detail: short(it.aggregated_output, 1500), ok: it.exit_code === 0 }];
    }
    if (it.type === "file_change") return (it.changes || []).map((c) => ({ kind: "edit", text: `${c.kind || "edit"} ${rel(c.path, base)}` }));
    if (it.type === "web_search") return [{ kind: "search", text: it.query || "web search" }];
    if (it.type === "error") return [{ kind: "error", text: it.message }];
    if (it.type === "mcp_tool_call") {
      if (it.status === "failed" || it.error) return [{ kind: "error", text: short(`${it.tool}: ${it.error?.message || it.error || it.result?.content?.[0]?.text || "failed"}`, 300) }];
      let a = it.arguments; if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
      a = a || {};
      if (it.tool === "delegate" || it.tool === "project_map" || String(it.tool).startsWith("job_")) return [toolUse({ name: `mcp__tokenwise-studio__${it.tool}`, input: a }, base)];
      return [{ kind: "tool", text: `${it.tool} ${short(JSON.stringify(a), 120)}` }];
    }
  }
  if (e.type === "turn.completed" && e.usage) {
    const u = e.usage;
    return [{ kind: "usage", text: `${(u.input_tokens || 0).toLocaleString()} in (${(u.cached_input_tokens || 0).toLocaleString()} cached) · ${(u.output_tokens || 0).toLocaleString()} out`, usage: u }];
  }
  if (e.type === "error" || e.type === "turn.failed") return [{ kind: "error", text: e.message || e.error?.message || "error" }];
  return [];
}

function toolUse(t, base) {
  const i = t.input || {};
  const n = t.name || "";
  if (n.endsWith("__delegate")) return { kind: "delegate", text: `${i.agent} ${i.model || ""} · ${i.effort || "default"}${i.write ? " · writes" : ""}: ${short(i.title || i.task, 140)}` };
  if (n.endsWith("__project_map")) return { kind: "tool", text: "project map" + (i.prefix ? ` ${i.prefix}` : i.name ? ` ${i.name}` : "") };
  if (n.includes("__job_")) return { kind: "tool", text: n.split("__").pop().replace("_", " ") + (i.id ? ` ${i.id}` : "") };
  if (n === "Read") return { kind: "read", text: rel(i.file_path, base) };
  if (n === "Edit" || n === "Write" || n === "MultiEdit") return { kind: "edit", text: `${n.toLowerCase()} ${rel(i.file_path, base)}` };
  if (n === "Bash") return { kind: "cmd", text: short(i.command, 200) };
  if (n === "Grep" || n === "Glob") return { kind: "search", text: `${n.toLowerCase()} ${i.pattern || ""}` };
  if (n === "WebSearch") return { kind: "search", text: short(i.query || "web search", 120) };
  if (n === "WebFetch") return { kind: "read", text: short(i.url || "web page", 120) };
  return { kind: "tool", text: `${n} ${short(JSON.stringify(i), 120)}` };
}

function claude(e, base) {
  if (e.type === "system" && e.subtype === "init") return [{ kind: "meta", text: `session started · ${e.model || ""}`, sessionId: e.session_id }];
  if (e.type === "assistant" && e.message?.content) {
    const out = [];
    for (const c of e.message.content) {
      if (c.type === "text" && c.text.trim()) out.push({ kind: "say", text: c.text });
      if (c.type === "thinking" && c.thinking) out.push({ kind: "think", text: c.thinking });
      if (c.type === "tool_use" && !["ToolSearch", "TodoWrite"].includes(c.name)) out.push(toolUse(c, base));
    }
    return out;
  }
  if (e.type === "user" && e.message?.content) {
    return e.message.content.filter((c) => c.type === "tool_result" && c.is_error)
      .map((c) => ({ kind: "error", text: short(typeof c.content === "string" ? c.content : JSON.stringify(c.content), 300) }));
  }
  if (e.type === "result") {
    return [{ kind: "done", text: `${e.is_error ? "failed" : "finished"} · ${e.num_turns ?? "?"} turns · $${(e.total_cost_usd || 0).toFixed(3)} API-equiv.`, cost: e.total_cost_usd, sessionId: e.session_id }];
  }
  return [];
}

const AGY_TOOL = {
  read_file: "read", view_file: "read", list_dir: "search", grep_search: "search", find_by_name: "search",
  search_web: "search", read_url_content: "read", view_web_page: "read",
  edit_file: "edit", write_to_file: "edit", replace_file_content: "edit", multi_replace_file_content: "edit", sed_file: "edit",
  run_command: "cmd",
};
function antigravity(e, base) {
  if (e.event === "init") return [{ kind: "meta", text: `session started · ${e.init?.model || ""}` }];
  const s = e.step_update;
  if (s && s.state === "DONE" && s.step_type === "tool") {
    const p = s.tool_info?.parameters || {};
    const kind = AGY_TOOL[s.tool_name] || "tool";
    const target = p.Path || p.TargetFile || p.AbsolutePath || p.DirectoryPath || p.SearchPath || "";
    if (kind === "cmd") return [{ kind, text: short(p.CommandLine || p.Command || s.tool_name, 200) }];
    if (kind === "search") return [{ kind, text: `${s.tool_name} ${short(p.Query || p.Pattern || rel(target, base), 120)}` }];
    if (kind === "tool") return [{ kind, text: s.tool_name }];
    return [{ kind, text: kind === "edit" ? `edit ${rel(target, base)}` : rel(target, base) }];
  }
  if (e.event === "result" && e.result) {
    const r = e.result, u = r.usage || {};
    const out = [];
    if (r.response) out.push({ kind: "say", text: r.response.replace(/\[`?([^\]`]+)`?\]\(file:\/\/[^)]*\)/g, "`$1`") });
    out.push({ kind: "usage", text: `${(u.input_tokens || 0).toLocaleString()} in (${(u.cache_read_tokens || 0).toLocaleString()} cached) · ${(u.output_tokens || 0).toLocaleString()} out` });
    out.push({ kind: r.status === "SUCCESS" ? "done" : "error", text: `${(r.status || "").toLowerCase()} · ${Math.round(r.duration_seconds || 0)}s` });
    return out;
  }
  return [];
}

function gemini(e) {
  if (e.type === "message" && e.role === "assistant" && e.content) return [{ kind: "say", text: e.content }];
  if (e.type === "tool_use") return [{ kind: "tool", text: `${e.tool_name || e.name || "tool"} ${short(JSON.stringify(e.parameters || e.args || {}), 120)}` }];
  if (e.type === "result") return [{ kind: "done", text: e.status || "finished" }];
  if (e.type === "error") return [{ kind: "error", text: e.message || "error" }];
  if (typeof e.text === "string") return [{ kind: "say", text: e.text }];
  return [];
}

/** Normalise one stored log entry {stream, line}. */
export function normalize(agent, entry, base) {
  if (entry.stream === "handoff") { try { return [{ kind: "handoff", ...JSON.parse(entry.line) }]; } catch { return []; } }
  if (entry.stream === "compact") {
    try {
      const d = JSON.parse(entry.line);
      return [{ kind: "compact", text: d.text || COMPACT_NOTICE, summary: d.summary || "", method: d.method || "haiku", tokens: d.tokens || 0, threshold: d.threshold || 0, throughTurn: d.throughTurn ?? null }];
    } catch {
      return [{ kind: "compact", text: entry.line || COMPACT_NOTICE, summary: "" }];
    }
  }
  if (entry.stream === "meta") return [{ kind: "meta", text: entry.line }];
  if (entry.stream === "notice") return [{ kind: "notice", text: entry.line }];
  if (entry.stream === "err") {
    const l = entry.line.trim();
    if (!l || /^Reading (additional )?(input|prompt) from stdin/i.test(l)) return [];
    return [{ kind: /error|fail|denied/i.test(l) ? "error" : "meta", text: short(l, 400) }];
  }
  let e; try { e = JSON.parse(entry.line); } catch { return [{ kind: "say", text: entry.line }]; }
  if (agent === "codex" || agent === "local") return codex(e, base);
  if (agent === "claude") return claude(e, base);
  if (e.event) return antigravity(e, base);
  if (typeof e.type === "string" && e.type.startsWith("free.")) {
    if (e.type === "free.init") return [{ kind: "meta", text: `free API · ${e.provider} · ${e.model}` }];
    if (e.type === "free.skip") return [{ kind: "meta", text: `${e.model ? `${e.provider} · ${e.model}` : e.provider} unavailable (${e.message}); trying the next ${e.model ? "free model" : "free provider"}` }];
    if (e.type === "free.message") return [{ kind: "say", text: e.text }];
    if (e.type === "free.tool") return [{ kind: e.error ? "error" : e.kind, text: e.error ? `${e.text}: ${e.error}` : e.text }];
    if (e.type === "free.usage") return [{ kind: "usage", text: `${e.usage?.prompt_tokens ?? 0} in · ${e.usage?.completion_tokens ?? 0} out` }];
    if (e.type === "free.error") return [{ kind: "error", text: e.message }];
  }
  return gemini(e);
}
