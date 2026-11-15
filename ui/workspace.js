// Shared dependency-free helpers for the side workspace panel:
// 1. file:line link parser for chat replies
// 2. read-only syntax highlighter tokenizer (lua/luau, js/ts, json, md, py)

const SECRET_NAME_RE = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.dev\.vars$/i,
  /\.(pem|key|p12|pfx|keystore|jks|tfvars|tfstate)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/i,
  /^(credentials|secrets?)(\.\w+)?$/i,
];
const BLOCKED_SEGMENTS = new Set([".git", ".tokenwise-studio", ".docker", ".ssh", ".aws", ".gnupg"]);

export function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Validate that a relative file path from a chat file:line reference is safe and plausible. */
export function normalizeWorkspaceRefPath(rawPath) {
  let p = String(rawPath ?? "").trim();
  if (!p || p.includes("\0") || p.includes("://")) return null;
  if (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("/") || p.startsWith("\\") || p.endsWith("/") || p.endsWith(".")) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === "..")) return null;
  if (parts.some((s) => BLOCKED_SEGMENTS.has(s.normalize("NFKC").toLowerCase()))) return null;
  const base = parts[parts.length - 1];
  if (SECRET_NAME_RE.some((re) => re.test(base.normalize("NFKC").toLowerCase()))) return null;
  // Require either a subdirectory slash (e.g. src/Makefile) or a letter-prefixed file extension (excludes 127.0.0.1, localhost, 12:30).
  const hasSlash = parts.length > 1;
  const hasExt = /\.[A-Za-z][A-Za-z0-9]{0,11}$/.test(base);
  if (!hasSlash && !hasExt) return null;
  return p;
}

const SCAN_RE = /([a-z][a-z0-9+.-]{0,39}:\/\/[^\s<>[\]()]+)|([A-Za-z0-9_.][A-Za-z0-9_.\-/]{0,299}):([1-9]\d*)(?:(?::([1-9]\d*))|(?:-([1-9]\d*)))?/gi;
const PREV_OK = /^[\s(\[{"'`:,<>*\u2014\u2013-]$/;
const NEXT_OK = /^[\s)\]}"'`.,;!?<>*]$/;

/** Find clickable file:line references in plain text (ignoring URLs, hosts/IPs, times, absolute/parent paths). */
export function parseFileLineRefs(text) {
  const s = String(text ?? "");
  const refs = [];
  // Scan line by line and skip very long lines (minified output, base64): the file:line pattern is quadratic on them.
  let offset = 0;
  for (const line of s.split("\n")) {
    if (line.length <= MAX_SCAN_LINE) scanLine(s, line, offset, refs);
    offset += line.length + 1;
  }
  return refs;
}
const MAX_SCAN_LINE = 2000;

function scanLine(s, line, offset, refs) {
  for (const m of line.matchAll(SCAN_RE)) {
    if (m[1]) continue; // skip URLs (http://, https://, file://, etc.)
    const idx = m.index + offset;
    const prev = idx > 0 ? s[idx - 1] : "";
    const afterIdx = idx + m[0].length;
    const next = afterIdx < s.length ? s[afterIdx] : "";
    if (prev && !PREV_OK.test(prev)) continue;
    if (next && !NEXT_OK.test(next)) continue;
    const cleanPath = normalizeWorkspaceRefPath(m[2]);
    if (!cleanPath) continue;
    refs.push({
      raw: m[0],
      path: cleanPath,
      line: Number(m[3]),
      col: m[4] ? Number(m[4]) : null,
      endLine: m[5] ? Number(m[5]) : null,
      index: idx,
      length: m[0].length,
    });
  }
}

// ---------- Syntax highlighter ----------

const EXT_LANG = {
  lua: "lua", luau: "lua",
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js",
  json: "json", jsonc: "json",
  md: "md", markdown: "md",
  py: "py", pyw: "py", pyi: "py",
};

export function detectLanguage(filePath) {
  const m = String(filePath || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && EXT_LANG[m[1]]) || "plain";
}

const KEYWORDS = {
  lua: new Set(["and", "break", "continue", "do", "else", "elseif", "end", "export", "for", "function", "if", "in", "local", "not", "or", "repeat", "return", "then", "type", "typeof", "until", "while"]),
  js: new Set(["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new", "of", "readonly", "return", "satisfies", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield"]),
  py: new Set(["and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]),
};

const LITERALS = {
  lua: new Set(["true", "false", "nil"]),
  js: new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]),
  json: new Set(["true", "false", "null"]),
  py: new Set(["True", "False", "None"]),
};

const TYPES = {
  lua: new Set(["self", "game", "workspace", "script", "task", "math", "table", "string", "bit32", "utf8", "coroutine", "debug", "os", "Instance", "Vector2", "Vector3", "CFrame", "Color3", "UDim2", "Enum", "print", "warn", "error", "require", "pcall", "xpcall", "pairs", "ipairs", "next", "select", "tonumber", "tostring", "setmetatable", "getmetatable"]),
  js: new Set(["Array", "Object", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Error", "TypeError", "JSON", "Math", "Date", "RegExp", "URL", "Buffer", "Uint8Array", "console", "process", "window", "document", "Number", "String", "Boolean", "Symbol", "BigInt"]),
  py: new Set(["self", "cls", "print", "len", "range", "dict", "list", "set", "tuple", "str", "int", "float", "bool", "bytes", "open", "enumerate", "zip", "map", "filter", "sorted", "isinstance", "issubclass", "Exception", "ValueError", "TypeError", "KeyError"]),
};

function scanQuoted(s, i, quote, allowMultiline = false) {
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "\\") { j += 2; continue; }
    if (ch === quote) return j + 1;
    if (!allowMultiline && ch === "\n") return j;
    j++;
  }
  return s.length;
}

function scanLuaLongBracket(s, i) {
  if (s[i] !== "[") return -1;
  let eq = 0;
  let k = i + 1;
  while (s[k] === "=") { eq++; k++; }
  if (s[k] !== "[") return -1;
  const close = "]" + "=".repeat(eq) + "]";
  const end = s.indexOf(close, k + 1);
  return end >= 0 ? end + close.length : s.length;
}

function pushTextTokens(lines, type, text) {
  const parts = text.split("\n");
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) lines.push([]);
    if (parts[p]) lines[lines.length - 1].push({ type, value: parts[p] });
  }
}

function tokenizeMarkdown(code) {
  const rawLines = String(code ?? "").split("\n");
  const out = [];
  let inFence = false;
  for (const line of rawLines) {
    const toks = [];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      toks.push({ type: "com", value: line });
      out.push(toks);
      continue;
    }
    if (inFence) {
      toks.push({ type: "str", value: line });
      out.push(toks);
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      toks.push({ type: "hd", value: line });
      out.push(toks);
      continue;
    }
    if (/^\s*>/.test(line)) {
      toks.push({ type: "com", value: line });
      out.push(toks);
      continue;
    }
    let i = 0;
    const listM = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/);
    if (listM) {
      toks.push({ type: "kw", value: listM[1] });
      i = listM[1].length;
    }
    while (i < line.length) {
      if (line[i] === "`") {
        const end = line.indexOf("`", i + 1);
        if (end > i) {
          toks.push({ type: "str", value: line.slice(i, end + 1) });
          i = end + 1;
          continue;
        }
      }
      if (line[i] === "*" && line[i + 1] === "*") {
        const end = line.indexOf("**", i + 2);
        if (end > i + 1) {
          toks.push({ type: "kw", value: line.slice(i, end + 2) });
          i = end + 2;
          continue;
        }
      }
      if (line[i] === "[") {
        const m = line.slice(i).match(/^\[[^\]]+\]\([^)]+\)/);
        if (m) {
          toks.push({ type: "type", value: m[0] });
          i += m[0].length;
          continue;
        }
      }
      let j = i + 1;
      while (j < line.length && line[j] !== "`" && !(line[j] === "*" && line[j + 1] === "*") && line[j] !== "[") j++;
      toks.push({ type: "plain", value: line.slice(i, j) });
      i = j;
    }
    out.push(toks);
  }
  return out;
}

/** Tokenize source text into per-line token arrays: [{ type, value }, ...]. */
export function tokenizeLines(code, lang = "plain") {
  const s = String(code ?? "").replace(/\r\n?/g, "\n");
  if (lang === "md") return tokenizeMarkdown(s);
  if (lang === "plain") {
    return s.split("\n").map((l) => (l ? [{ type: "plain", value: l }] : []));
  }

  const lines = [[]];
  const kw = KEYWORDS[lang] || new Set();
  const lit = LITERALS[lang] || new Set();
  const ty = TYPES[lang] || new Set();
  const n = s.length;
  let i = 0;

  while (i < n) {
    const ch = s[i];

    if (ch === "\n") {
      lines.push([]);
      i++;
      continue;
    }

    // Comments
    if (lang === "lua" && ch === "-" && s[i + 1] === "-") {
      const longEnd = s[i + 2] === "[" ? scanLuaLongBracket(s, i + 2) : -1;
      if (longEnd > 0) {
        pushTextTokens(lines, "com", s.slice(i, longEnd));
        i = longEnd;
      } else {
        const nl = s.indexOf("\n", i);
        const end = nl >= 0 ? nl : n;
        lines[lines.length - 1].push({ type: "com", value: s.slice(i, end) });
        i = end;
      }
      continue;
    }
    if ((lang === "js" || lang === "json") && ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      const end = nl >= 0 ? nl : n;
      lines[lines.length - 1].push({ type: "com", value: s.slice(i, end) });
      i = end;
      continue;
    }
    if ((lang === "js" || lang === "json") && ch === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      const end = close >= 0 ? close + 2 : n;
      pushTextTokens(lines, "com", s.slice(i, end));
      i = end;
      continue;
    }
    if (lang === "py" && ch === "#") {
      const nl = s.indexOf("\n", i);
      const end = nl >= 0 ? nl : n;
      lines[lines.length - 1].push({ type: "com", value: s.slice(i, end) });
      i = end;
      continue;
    }

    // Python triple-quoted strings and decorators
    if (lang === "py" && (s.startsWith('"""', i) || s.startsWith("'''", i))) {
      const q = s.slice(i, i + 3);
      let j = i + 3;
      while (j < n) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s.startsWith(q, j)) { j += 3; break; }
        j++;
      }
      pushTextTokens(lines, "str", s.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }
    if (lang === "py" && ch === "@" && /[A-Za-z_]/.test(s[i + 1] || "")) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(s[j])) j++;
      lines[lines.length - 1].push({ type: "type", value: s.slice(i, j) });
      i = j;
      continue;
    }

    // Lua long bracket strings [[...]]
    if (lang === "lua" && ch === "[") {
      const longEnd = scanLuaLongBracket(s, i);
      if (longEnd > 0) {
        pushTextTokens(lines, "str", s.slice(i, longEnd));
        i = longEnd;
        continue;
      }
    }

    // Quoted strings (and JS/Luau template/interpolated backticks)
    if (ch === '"' || ch === "'" || ((lang === "js" || lang === "lua") && ch === "`")) {
      const allowMulti = ch === "`";
      const end = scanQuoted(s, i, ch, allowMulti);
      let type = "str";
      if (lang === "json" && ch === '"') {
        let k = end;
        while (k < n && (s[k] === " " || s[k] === "\t")) k++;
        if (s[k] === ":") type = "key";
      }
      pushTextTokens(lines, type, s.slice(i, end));
      i = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[i + 1] || ""))) {
      let j = i;
      if (s[j] === "0" && /[xXbBoO]/.test(s[j + 1] || "")) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(s[j])) j++;
      } else {
        while (j < n && /[0-9._]/.test(s[j])) j++;
        if ((s[j] === "e" || s[j] === "E") && /[0-9+-]/.test(s[j + 1] || "")) {
          j++;
          if (s[j] === "+" || s[j] === "-") j++;
          while (j < n && /[0-9_]/.test(s[j])) j++;
        }
      }
      lines[lines.length - 1].push({ type: "num", value: s.slice(i, j) });
      i = j;
      continue;
    }

    // Identifiers / keywords / literals / types
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const type = kw.has(word) ? "kw" : lit.has(word) ? "lit" : ty.has(word) ? "type" : "plain";
      lines[lines.length - 1].push({ type, value: word });
      i = j;
      continue;
    }

    // Plain punctuation/whitespace batch
    let j = i + 1;
    while (
      j < n &&
      s[j] !== "\n" &&
      !/[A-Za-z0-9_$"'`#@./\-\[]/.test(s[j])
    ) {
      j++;
    }
    lines[lines.length - 1].push({ type: "plain", value: s.slice(i, j) });
    i = j;
  }

  return lines;
}

const VALID_TOK = new Set(["kw", "lit", "num", "str", "com", "type", "key", "hd"]);

/** Render tokenized lines into safe line-numbered HTML rows. */
export function renderHighlightedLinesHtml(code, lang = "plain", { highlightLine = 0 } = {}) {
  const lines = tokenizeLines(code, lang);
  const target = Number(highlightLine) || 0;
  return lines.map((toks, idx) => {
    const ln = idx + 1;
    const inner = toks.length
      ? toks.map((t) => (VALID_TOK.has(t.type) ? `<span class="tok-${t.type}">${escHtml(t.value)}</span>` : escHtml(t.value))).join("")
      : " ";
    return `<div class="cv-line${ln === target ? " is-target" : ""}" data-line="${ln}"><span class="cv-ln">${ln}</span><span class="cv-code">${inner}</span></div>`;
  }).join("");
}
