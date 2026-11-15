// Pure command palette fuzzy matcher and shortcut formatting helpers.
// Shared by ui/index.html and Node tests.

const BOUNDARY_RE = /[\s/\\._:-]/;

function isWordBoundary(text, idx) {
  if (idx <= 0) return true;
  const prev = text[idx - 1];
  const cur = text[idx];
  if (BOUNDARY_RE.test(prev)) return true;
  // camelCase boundary: lowercase followed by uppercase
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return true;
  return false;
}

function subsequenceFastCheck(tok, lowerTarget) {
  let ti = 0;
  for (let i = 0; i < lowerTarget.length && ti < tok.length; i++) {
    if (lowerTarget[i] === tok[ti]) ti++;
  }
  return ti === tok.length;
}

function scoreSingleToken(tok, text) {
  if (!tok || !text) return null;
  const raw = String(text);
  const lower = raw.toLowerCase();
  if (!subsequenceFastCheck(tok, lower)) return null;

  // Check exact contiguous substring occurrences first; pick best boundary position.
  let bestSub = null;
  let pos = lower.indexOf(tok);
  while (pos !== -1) {
    let s = 140 + tok.length * 14 - raw.length * 0.15;
    if (pos === 0) s += 80;
    else if (isWordBoundary(raw, pos)) s += 45;
    if (!bestSub || s > bestSub.score) {
      const indices = [];
      for (let k = 0; k < tok.length; k++) indices.push(pos + k);
      bestSub = { score: s, indices };
    }
    pos = lower.indexOf(tok, pos + 1);
  }
  if (bestSub) return bestSub;

  // DP over bounded lengths for optimal non-contiguous fuzzy alignment.
  const q = tok.slice(0, 32);
  const m = q.length;
  const n = Math.min(raw.length, 200);
  const NEG = -1e9;

  // dp[j] = best score ending at target index j for current query char i
  let prevDp = new Array(n).fill(NEG);
  const back = Array.from({ length: m }, () => new Int16Array(n).fill(-1));

  for (let j = 0; j < n; j++) {
    if (lower[j] === q[0]) {
      prevDp[j] = (j === 0 ? 32 : isWordBoundary(raw, j) ? 24 : 6) - j * 0.25;
    }
  }

  for (let i = 1; i < m; i++) {
    const curDp = new Array(n).fill(NEG);
    let bestSoFar = NEG;
    let bestIdx = -1;
    for (let j = 0; j < n; j++) {
      if (j > 0 && prevDp[j - 1] > bestSoFar) {
        bestSoFar = prevDp[j - 1];
        bestIdx = j - 1;
      }
      if (bestIdx !== -1 && lower[j] === q[i]) {
        const consecutive = bestIdx === j - 1 ? 22 : -Math.min(12, (j - bestIdx - 1) * 0.6);
        const boundary = isWordBoundary(raw, j) ? 18 : 0;
        curDp[j] = bestSoFar + 10 + consecutive + boundary;
        back[i][j] = bestIdx;
      }
    }
    prevDp = curDp;
  }

  let bestEnd = -1;
  let bestScore = NEG;
  for (let j = 0; j < n; j++) {
    if (prevDp[j] > bestScore) {
      bestScore = prevDp[j];
      bestEnd = j;
    }
  }
  if (bestEnd === -1 || bestScore <= NEG / 2) return null;

  const indices = new Array(m);
  let cur = bestEnd;
  for (let i = m - 1; i >= 0; i--) {
    indices[i] = cur;
    cur = back[i][cur];
  }
  return { score: bestScore - raw.length * 0.15, indices };
}

/**
 * Match a search query against `text` (and optional `keywords`).
 * Multi-word queries require every token to match `text` or `keywords`.
 * Returns `{ score, indices }` or `null`.
 */
export function fuzzyMatch(query, text, keywords = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const tokens = q.split(/\s+/).filter(Boolean);
  let totalScore = 0;
  const idxSet = new Set();

  for (const tok of tokens) {
    const primary = scoreSingleToken(tok, text);
    const secondary = keywords ? scoreSingleToken(tok, keywords) : null;
    if (!primary && !secondary) return null;

    if (primary && (!secondary || primary.score >= secondary.score * 0.45)) {
      totalScore += primary.score;
      for (const idx of primary.indices) idxSet.add(idx);
    } else if (secondary) {
      totalScore += secondary.score * 0.45;
    }
  }

  return {
    score: totalScore,
    indices: [...idxSet].sort((a, b) => a - b),
  };
}

/**
 * Filter and rank palette items by fuzzy match score.
 * Each item should have `{ label, keywords?, group?, priority? }`.
 */
export function filterPaletteItems(query, items = []) {
  const q = String(query || "").trim();
  if (!q) {
    return items.map((item) => ({ item, score: 0, indices: [] }));
  }

  const hits = [];
  items.forEach((item, order) => {
    const m = fuzzyMatch(q, item?.label || "", item?.keywords || "");
    if (!m) return;
    const boost = Number(item?.priority || 0);
    hits.push({ item, score: m.score + boost, indices: m.indices, order });
  });

  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.order - b.order));
  return hits.map(({ item, score, indices }) => ({ item, score, indices }));
}

/** Format a shortcut key list (e.g. ["mod", "K"]) for macOS vs Windows/Linux. */
export function formatShortcut(keys, isMac = true) {
  const list = Array.isArray(keys) ? keys : String(keys || "").split(/\s+/).filter(Boolean);
  return list.map((k) => {
    if (k === "mod" || k === "⌘") return isMac ? "⌘" : "Ctrl";
    if (k === "shift" || k === "⇧") return isMac ? "⇧" : "Shift";
    if (k === "alt" || k === "⌥") return isMac ? "⌥" : "Alt";
    return k;
  });
}
