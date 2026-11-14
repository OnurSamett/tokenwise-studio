// Citation & Sources parser and safe Markdown/link renderer (only http/https URLs become links).
// Shared between ui/index.html (browser / Mac WKWebView) and Node unit tests.

export function safeHttpUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || /[\s\u0000-\u001f]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.href;
}

export function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function trimBareUrl(raw) {
  let u = raw;
  let tail = "";
  while (u.length) {
    const last = u[u.length - 1];
    if (/[.,;:!?]/.test(last)) { tail = last + tail; u = u.slice(0, -1); continue; }
    if (last === ")") {
      const open = (u.match(/\(/g) || []).length;
      const close = (u.match(/\)/g) || []).length;
      if (close > open) { tail = ")" + tail; u = u.slice(0, -1); continue; }
    }
    break;
  }
  return { url: u, tail };
}

function cleanTitle(s) {
  return String(s ?? "")
    .replace(/^\s*[-–—:|•*]+\s*/, "")
    .replace(/\s*[-–—:|]+\s*$/, "")
    .replace(/^["'`*_\[\(]+|["'`*_\]\)]+$/g, "")
    .trim();
}

export function parseSourceLine(line, fallbackNum = null) {
  let s = String(line ?? "").trim().replace(/^[-*•]\s+/, "");
  if (!s) return null;

  let num = null;
  let rest = s;
  let m = s.match(/^\[(\d{1,3})\]:?\s+(.+)$/);
  if (m) {
    num = Number(m[1]);
    rest = m[2].trim();
  } else if ((m = s.match(/^(\d{1,3})[.)]\s+(.+)$/))) {
    num = Number(m[1]);
    rest = m[2].trim();
  } else if (fallbackNum != null) {
    num = fallbackNum;
  } else {
    return null;
  }

  // 1. Markdown link: [Title](url)
  const mdLink = rest.match(/\[([^\]]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/);
  if (mdLink) {
    const rawUrl = mdLink[2].trim();
    const url = safeHttpUrl(rawUrl);
    const title = cleanTitle(mdLink[1]) || (url ? new URL(url).hostname.replace(/^www\./i, "") : rawUrl);
    const host = url ? new URL(url).hostname.replace(/^www\./i, "") : "";
    return { num, title, url, host, rawUrl };
  }

  // 2. Bare http/https URL (optionally preceded or followed by a title/description)
  const httpMatch = rest.match(/https?:\/\/[^\s<>[\]]+/i);
  if (httpMatch) {
    const { url: candidate } = trimBareUrl(httpMatch[0]);
    const url = safeHttpUrl(candidate);
    const before = cleanTitle(rest.slice(0, httpMatch.index));
    const after = cleanTitle(rest.slice(httpMatch.index + httpMatch[0].length));
    const host = url ? new URL(url).hostname.replace(/^www\./i, "") : "";
    const title = before || after || host || candidate;
    return { num, title, url, host, rawUrl: candidate };
  }

  // 3. Non-http scheme URL (e.g. javascript:, data:, file:, ftp:, mailto:, vbscript:)
  const schemeMatch = rest.match(/\b([a-z][a-z0-9+.-]*:[^\s)>\]"']+)/i);
  if (schemeMatch) {
    const rawUrl = schemeMatch[1];
    const before = cleanTitle(rest.slice(0, schemeMatch.index));
    const after = cleanTitle(rest.slice(schemeMatch.index + schemeMatch[0].length));
    const title = before || after || rawUrl;
    return { num, title, url: null, host: "", rawUrl };
  }

  return null;
}

const SOURCES_HEADING = /^(?:#{1,4}\s*)?(?:\*\*|__)?(?:sources|references|kaynaklar)(?:\*\*|__)?\s*:?\s*$/i;
const SOURCES_INLINE = /^(?:#{1,4}\s*)?(?:\*\*|__)?(?:sources|references|kaynaklar)(?:\*\*|__)?\s*:\s*(.+)$/i;
const REF_DEF = /^\[(\d{1,3})\]:\s*(\S+)(?:\s+["']([^"']+)["'])?\s*$/;

export function parseCitations(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  // Locate the last Sources heading outside fenced code blocks.
  let inCode = false;
  let headingIdx = -1;
  let inlineTail = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (SOURCES_HEADING.test(l.trim())) { headingIdx = i; inlineTail = null; continue; }
    const im = l.trim().match(SOURCES_INLINE);
    if (im) { headingIdx = i; inlineTail = im[1]; }
  }

  if (headingIdx >= 0) {
    const parsed = [];
    let endIdx = headingIdx;
    let nextFallback = 1;
    if (inlineTail) {
      const item = parseSourceLine(inlineTail, nextFallback);
      if (item) { parsed.push(item); nextFallback = item.num + 1; }
    }
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) {
        if (parsed.length === 0) continue;
        // Peek ahead: if next non-empty line is another source item, keep going.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && parseSourceLine(lines[j], nextFallback)) continue;
        break;
      }
      const item = parseSourceLine(t, nextFallback);
      if (!item) break;
      parsed.push(item);
      nextFallback = item.num + 1;
      endIdx = i;
    }
    if (parsed.length > 0) {
      let cutStart = headingIdx;
      while (cutStart > 0 && !lines[cutStart - 1].trim()) cutStart--;
      if (cutStart > 0 && /^---+$/.test(lines[cutStart - 1].trim())) cutStart--;
      while (cutStart > 0 && !lines[cutStart - 1].trim()) cutStart--;
      const before = lines.slice(0, cutStart);
      const after = lines.slice(endIdx + 1);
      while (after.length && !after[0].trim()) after.shift();
      const body = [...before, ...(before.length && after.length ? [""] : []), ...after].join("\n").trimEnd();
      const sources = dedupeSources(parsed);
      return { body, sources, hasSources: sources.length > 0 };
    }
  }

  // Fallback: trailing markdown reference-link definitions like `[1]: https://... "Title"`
  let refStart = lines.length;
  const refs = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) { if (refs.length) refStart = i; continue; }
    const rm = t.match(REF_DEF);
    if (!rm) break;
    const rawUrl = rm[2];
    const url = safeHttpUrl(rawUrl);
    const host = url ? new URL(url).hostname.replace(/^www\./i, "") : "";
    refs.unshift({ num: Number(rm[1]), title: rm[3]?.trim() || host || rawUrl, url, host, rawUrl });
    refStart = i;
  }
  if (refs.length > 0) {
    const body = lines.slice(0, refStart).join("\n").trimEnd();
    const sources = dedupeSources(refs);
    return { body, sources, hasSources: sources.length > 0 };
  }

  return { body: raw, sources: [], hasSources: false };
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || seen.has(s.num)) continue;
    seen.add(s.num);
    out.push(s);
  }
  return out;
}

function renderBoldAndEsc(s) {
  return escHtml(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

function renderTextAndCitations(s, srcMap) {
  const re = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]|(https?:\/\/[^\s<>]+)/gi;
  let out = "";
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out += renderBoldAndEsc(s.slice(last, m.index));
    if (m[1]) {
      const nums = m[1].split(",").map((x) => Number(x.trim()));
      const anySafe = nums.some((n) => srcMap.has(n));
      if (!anySafe) {
        out += escHtml(m[0]);
      } else if (nums.length === 1) {
        const src = srcMap.get(nums[0]);
        const title = src.title && src.host && src.title !== src.host ? `${src.title} — ${src.host}` : (src.title || src.url);
        out += `<a class="cite" href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer" title="${escHtml(title)}">[${nums[0]}]</a>`;
      } else {
        out += "[" + nums.map((n) => {
          const src = srcMap.get(n);
          if (!src) return String(n);
          const title = src.title && src.host && src.title !== src.host ? `${src.title} — ${src.host}` : (src.title || src.url);
          return `<a class="cite" href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer" title="${escHtml(title)}">${n}</a>`;
        }).join(", ") + "]";
      }
    } else if (m[2]) {
      const { url: candidate, tail } = trimBareUrl(m[2]);
      const safe = safeHttpUrl(candidate);
      if (safe) {
        out += `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer">${escHtml(candidate)}</a>${escHtml(tail)}`;
      } else {
        out += escHtml(m[0]);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out += renderBoldAndEsc(s.slice(last));
  return out;
}

function renderNonCodeSegment(s, srcMap) {
  const linkRe = /\[([^\]]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/g;
  let out = "";
  let last = 0;
  for (const m of s.matchAll(linkRe)) {
    if (m.index > last) out += renderTextAndCitations(s.slice(last, m.index), srcMap);
    const safe = safeHttpUrl(m[2]);
    if (safe) {
      out += `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer">${renderBoldAndEsc(m[1])}</a>`;
    } else {
      // Non-http(s) links (javascript:, data:, file:, ftp:, etc.) must never be linkified.
      out += escHtml(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out += renderTextAndCitations(s.slice(last), srcMap);
  return out;
}

export function renderInlineHtml(line, sources = []) {
  const srcMap = new Map();
  for (const s of sources || []) {
    if (s && s.url && safeHttpUrl(s.url)) srcMap.set(Number(s.num), s);
  }
  const codeRe = /`([^`]+)`/g;
  let out = "";
  let last = 0;
  for (const m of String(line ?? "").matchAll(codeRe)) {
    if (m.index > last) out += renderNonCodeSegment(line.slice(last, m.index), srcMap);
    out += `<code>${escHtml(m[1])}</code>`;
    last = m.index + m[0].length;
  }
  if (last < String(line ?? "").length) out += renderNonCodeSegment(String(line ?? "").slice(last), srcMap);
  return out;
}

export function renderMarkdownHtml(text, { sources = [] } = {}) {
  const out = [];
  let list = null;
  let code = null;
  const flush = () => { if (list) { out.push(`<${list.t}>` + list.items.join("") + `</${list.t}>`); list = null; } };
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*```/.test(line)) {
      if (code) { out.push("<pre>" + escHtml(code.join("\n")) + "</pre>"); code = null; }
      else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const ol = line.match(/^\s*\d+[.)] (.*)/), ul = line.match(/^\s*[-*] (.*)/);
    if (ol || ul) {
      const t = ol ? "ol" : "ul";
      if (!list || list.t !== t) { flush(); list = { t, items: [] }; }
      list.items.push("<li>" + renderInlineHtml((ol || ul)[1], sources) + "</li>");
      continue;
    }
    flush();
    const hd = line.match(/^#{1,4}\s+(.*)/);
    if (hd) { out.push("<h4>" + renderInlineHtml(hd[1], sources) + "</h4>"); continue; }
    if (line.trim()) out.push("<p>" + renderInlineHtml(line, sources) + "</p>");
  }
  if (code) out.push("<pre>" + escHtml(code.join("\n")) + "</pre>");
  flush();
  return out.join("");
}
