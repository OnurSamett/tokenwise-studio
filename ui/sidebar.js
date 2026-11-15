// Pure sidebar grouping & date-bucketing helpers shared by ui/index.html and Node tests.

export const DATE_GROUPS = ["today", "yesterday", "week", "older"];

/** Best last-activity timestamp (ISO string or epoch) for a chat. */
export function chatActivityTime(chat) {
  const lastTurn = Array.isArray(chat?.turns) && chat.turns.length ? chat.turns[chat.turns.length - 1] : null;
  return lastTurn?.finished || lastTurn?.started || chat?.created || "";
}

function toMs(ts) {
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : NaN;
  if (ts instanceof Date) return ts.getTime();
  if (!ts) return NaN;
  return new Date(ts).getTime();
}

/**
 * Bucket a timestamp into "today" | "yesterday" | "week" | "older"
 * relative to local calendar midnight of `now`.
 */
export function dateGroupKey(ts, now = new Date()) {
  const t = toMs(ts);
  if (!Number.isFinite(t)) return "older";
  const ref = now instanceof Date ? now : new Date(toMs(now));
  const startToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const startYesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1).getTime();
  const startWeek = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 7).getTime();
  if (t >= startToday) return "today";
  if (t >= startYesterday) return "yesterday";
  if (t >= startWeek) return "week";
  return "older";
}

/** Sort chats newest-first by last activity time. */
export function sortChatsByActivity(chats = []) {
  return [...chats].sort((a, b) => {
    const ta = toMs(chatActivityTime(a));
    const tb = toMs(chatActivityTime(b));
    if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta;
    if (Number.isFinite(tb) && !Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb) && Number.isFinite(ta)) return -1;
    return String(b?.created || "").localeCompare(String(a?.created || ""));
  });
}

/** Sort folders with pinned folders first, preserving relative order inside each group. */
export function sortFolders(folders = []) {
  const pinned = [];
  const rest = [];
  for (const f of folders) {
    if (f?.pinned) pinned.push(f);
    else rest.push(f);
  }
  return [...pinned, ...rest];
}

/**
 * Group a list of chats into pinned (if any) + non-empty date groups
 * ("today", "yesterday", "week", "older"), each sorted newest-first.
 */
export function groupChatsByDate(chats = [], { pinnedIds = [], now = new Date() } = {}) {
  const pinSet = new Set(pinnedIds || []);
  const sorted = sortChatsByActivity(chats);
  const pinned = [];
  const buckets = { today: [], yesterday: [], week: [], older: [] };

  for (const c of sorted) {
    if (pinSet.has(c.id)) {
      pinned.push(c);
    } else {
      buckets[dateGroupKey(chatActivityTime(c), now)].push(c);
    }
  }

  const groups = [];
  for (const key of DATE_GROUPS) {
    if (buckets[key].length) groups.push({ key, chats: buckets[key] });
  }
  return { pinned, groups };
}

/** Partition chats into ordered folders and unfiled chats. */
export function partitionChatsByFolders(chats = [], foldersState = {}) {
  const folders = sortFolders(foldersState?.folders || []);
  const validIds = new Set(folders.map((f) => f.id));
  const chatFolder = foldersState?.chatFolder || {};
  const byFolder = Object.fromEntries(folders.map((f) => [f.id, []]));
  const unfiled = [];

  for (const c of sortChatsByActivity(chats)) {
    const fid = Object.hasOwn(chatFolder, c.id) ? chatFolder[c.id] : null;
    if (fid && validIds.has(fid)) byFolder[fid].push(c);
    else unfiled.push(c);
  }

  return {
    folders,
    byFolder,
    unfiled,
    pinnedIds: Array.isArray(foldersState?.pinnedChats) ? foldersState.pinnedChats : [],
  };
}
