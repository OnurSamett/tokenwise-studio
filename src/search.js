// Full-text chat search across titles, user messages, and orchestrator replies.
// Case- and diacritic-insensitive (including Turkish ı/İ/ş/ğ/ü/ö/ç) with safe snippet match offsets.
import { normalize } from "./events.js";

const MAX_TOKENS = 10;
const MAX_QUERY_LEN = 200;
const MAX_MATCHES_PER_FIELD = 24;
const MAX_HITS_PER_CHAT = 3;

/** Case- and diacritic-insensitive normalization, mapping Turkish İ/ı to i. */
export function normalizeSearchText(text) {
  return String(text ?? "")
    .replace(/\u0130/g, "I")
    .replace(/\u0131/g, "i")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Normalize text while recording a [origStart, origEnd] UTF-16 span for every
 * normalized character, so matches map back accurately onto the original string.
 */
export function normalizeWithMap(raw) {
  const src = String(raw ?? "");
  let norm = "";
  const spans = [];
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i);
    const charLen = cp > 0xffff ? 2 : 1;
    const ch = src.slice(i, i + charLen);
    const piece = normalizeSearchText(ch);
    if (!piece) {
      if (spans.length) spans[spans.length - 1][1] = i + charLen;
    } else {
      for (let j = 0; j < piece.length; j++) {
        norm += piece[j];
        spans.push([i, i + charLen]);
      }
    }
    i += charLen;
  }
  return { norm, spans };
}

export function tokenizeQuery(query) {
  const clipped = String(query ?? "").slice(0, MAX_QUERY_LEN);
  const normQuery = normalizeSearchText(clipped).trim().replace(/\s+/g, " ");
  if (!normQuery) return { normQuery: "", tokens: [] };
  const tokens = [];
  for (const tok of normQuery.split(" ")) {
    if (tok && !tokens.includes(tok)) {
      tokens.push(tok);
      if (tokens.length >= MAX_TOKENS) break;
    }
  }
  return { normQuery, tokens };
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= prev[1]) prev[1] = Math.max(prev[1], cur[1]);
    else out.push(cur.slice());
  }
  return out;
}

const isBoundaryChar = (ch) => !ch || /[\s/\\._:,\-()[\]{}"'`?!]/.test(ch);

export function matchText(raw, { normQuery, tokens }) {
  if (!tokens.length) return null;
  const clean = String(raw ?? "").replace(/[\r\n\t]/g, " ");
  if (!clean.trim()) return null;
  const { norm, spans } = normalizeWithMap(clean);
  if (!norm) return null;

  const rawRanges = [];
  let score = 0;

  if (tokens.length > 1) {
    const phraseIdx = norm.indexOf(normQuery);
    if (phraseIdx !== -1) {
      score += 120;
      if (norm === normQuery) score += 60;
      else if (phraseIdx === 0) score += 40;
    }
  } else {
    const singleIdx = norm.indexOf(tokens[0]);
    if (singleIdx !== -1) {
      if (norm === tokens[0]) score += 90;
      else if (singleIdx === 0) score += 35;
    }
  }

  for (const tok of tokens) {
    let pos = norm.indexOf(tok);
    if (pos === -1) return null;
    score += 25;
    let count = 0;
    let bestBoundary = false;
    while (pos !== -1 && rawRanges.length < MAX_MATCHES_PER_FIELD) {
      const end = pos + tok.length;
      if (pos === 0 || isBoundaryChar(norm[pos - 1])) bestBoundary = true;
      if (spans[pos] && spans[end - 1]) {
        rawRanges.push([spans[pos][0], spans[end - 1][1]]);
      }
      count++;
      if (count >= 6) break;
      pos = norm.indexOf(tok, pos + tok.length);
    }
    if (bestBoundary) score += 30;
    score += Math.min(3, count - 1) * 6;
  }

  return {
    clean,
    score,
    ranges: mergeRanges(rawRanges),
  };
}

export function buildSnippet(clean, ranges, maxLen = 140) {
  const s = String(clean ?? "");
  if (!s) return { snippet: "", matches: [] };
  if (s.length <= maxLen) {
    return { snippet: s, matches: mergeRanges(ranges) };
  }
  const first = ranges[0] || [0, 0];
  const lead = Math.min(42, Math.floor(maxLen * 0.3));
  let winStart = Math.max(0, first[0] - lead);
  if (winStart > 0) {
    const sp = s.indexOf(" ", winStart);
    if (sp !== -1 && sp - winStart <= 12 && sp + 1 <= first[0]) {
      winStart = sp + 1;
    }
  }
  let winEnd = Math.min(s.length, winStart + maxLen);
  if (winEnd === s.length) {
    winStart = Math.max(0, s.length - maxLen);
  } else {
    const sp = s.lastIndexOf(" ", winEnd);
    if (sp > first[1] && winEnd - sp <= 14) {
      winEnd = sp;
    }
  }

  const prefix = winStart > 0 ? "…" : "";
  const suffix = winEnd < s.length ? "…" : "";
  const snippet = prefix + s.slice(winStart, winEnd) + suffix;
  const shift = prefix.length - winStart;
  const matches = [];
  for (const [a, b] of ranges) {
    if (b <= winStart || a >= winEnd) continue;
    matches.push([Math.max(0, a - winStart) + prefix.length, Math.min(winEnd - winStart, b - winStart) + prefix.length]);
  }
  void shift;
  return { snippet, matches: mergeRanges(matches) };
}

function collectTurnRepliesFromLog(chats, chatId, repo) {
  const byTurn = new Map();
  let entries;
  try {
    ({ entries } = chats.log(chatId, 0));
  } catch {
    return byTurn;
  }
  for (const e of entries) {
    const ti = e.turn ?? 0;
    const items = normalize(e.agent || "claude", e, repo);
    for (const it of items) {
      if (it.kind === "say" && it.text) {
        if (!byTurn.has(ti)) byTurn.set(ti, []);
        byTurn.get(ti).push(it.text);
      }
    }
  }
  return byTurn;
}

const FIELD_WEIGHT = { title: 200, user: 120, reply: 90 };

/**
 * Full-text search across a project's chats (titles, user messages, and replies).
 * Returns `{ query, total, results }`.
 */
export function searchChats({ chats, repo = "", query = "", limit = 20 } = {}) {
  const qRaw = String(query ?? "").trim();
  const qInfo = tokenizeQuery(qRaw);
  if (!qInfo.tokens.length || !chats) {
    return { query: qRaw, total: 0, results: [] };
  }
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const list = chats.list();
  const allHits = [];
  let totalHits = 0;

  list.forEach((c, chatOrder) => {
    const recencyBoost = Math.max(0, 15 - chatOrder * 0.5);
    const title = String(c.title || c.id || "");
    const titleMatch = matchText(title, qInfo);
    const chatHits = [];

    if (titleMatch) {
      const { snippet, matches } = buildSnippet(titleMatch.clean, titleMatch.ranges, 120);
      chatHits.push({
        chatId: c.id,
        title,
        titleMatches: titleMatch.ranges,
        kind: "title",
        turn: 0,
        timestamp: c.turns?.[0]?.started || c.created || "",
        snippet,
        matches,
        score: FIELD_WEIGHT.title + titleMatch.score + recencyBoost,
      });
    }

    const turns = Array.isArray(c.turns) ? c.turns : [];
    const logReplies = turns.length ? collectTurnRepliesFromLog(chats, c.id, repo) : new Map();

    for (let ti = 0; ti < turns.length; ti++) {
      const t = turns[ti];
      if (t?.user) {
        const um = matchText(t.user, qInfo);
        if (um) {
          const { snippet, matches } = buildSnippet(um.clean, um.ranges);
          chatHits.push({
            chatId: c.id,
            title,
            titleMatches: titleMatch ? titleMatch.ranges : [],
            kind: "user",
            turn: ti,
            timestamp: t.started || c.created || "",
            snippet,
            matches,
            score: FIELD_WEIGHT.user + um.score + recencyBoost,
          });
        }
      }

      const sayParts = logReplies.get(ti) || [];
      const replyCandidates = [];
      for (const s of sayParts) {
        if (s && !replyCandidates.includes(s)) replyCandidates.push(s);
      }
      if (t?.reply && !replyCandidates.some((s) => s === t.reply || s.includes(t.reply))) {
        replyCandidates.push(t.reply);
      }
      const replyText = replyCandidates.join("\n").trim();
      if (replyText) {
        const rm = matchText(replyText, qInfo);
        if (rm) {
          const { snippet, matches } = buildSnippet(rm.clean, rm.ranges);
          chatHits.push({
            chatId: c.id,
            title,
            titleMatches: titleMatch ? titleMatch.ranges : [],
            kind: "reply",
            turn: ti,
            timestamp: t.finished || t.started || c.created || "",
            snippet,
            matches,
            score: FIELD_WEIGHT.reply + rm.score + recencyBoost,
          });
        }
      }
    }

    if (chatHits.length) {
      totalHits += chatHits.length;
      chatHits.sort((a, b) => b.score - a.score || (a.turn - b.turn));
      allHits.push(...chatHits.slice(0, MAX_HITS_PER_CHAT));
    }
  });

  allHits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
  });

  return {
    query: qRaw,
    total: totalHits,
    results: allHits.slice(0, lim).map((r) => ({ ...r, score: Math.round(r.score * 10) / 10 })),
  };
}
