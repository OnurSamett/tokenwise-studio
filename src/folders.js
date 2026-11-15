// Per-project chat folders, chat-to-folder assignments, and pinned chats/folders.
// Stored in <repo>/.tokenwise-studio/folders.json.
import fs from "node:fs";
import path from "node:path";

export const MAX_FOLDERS = 100;
export const MAX_FOLDER_NAME = 80;
export const FOLDER_ID_RE = /^[a-z0-9_-]{1,64}$/i;
export const CHAT_ID_RE = /^[a-z0-9_-]{1,80}$/i;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_ROOT_KEYS = new Set(["folders", "chatFolder", "pinnedChats"]);
const ALLOWED_FOLDER_KEYS = new Set(["id", "name", "pinned", "collapsed"]);

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export const foldersFile = (home) => path.join(home, "folders.json");

export const emptyFolders = () => ({ folders: [], chatFolder: {}, pinnedChats: [] });

function validateFolderName(name) {
  if (typeof name !== "string") throw new Error("folder name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("folder name cannot be empty");
  if (trimmed.length > MAX_FOLDER_NAME) throw new Error(`folder name must be at most ${MAX_FOLDER_NAME} characters`);
  return trimmed;
}

function validateId(id, re, label) {
  if (typeof id !== "string" || !re.test(id) || RESERVED_KEYS.has(id)) {
    throw new Error(`invalid ${label}`);
  }
  return id;
}

/** Validate and normalize a full folders state object. Throws on invalid input. */
export function normalizeFolders(input) {
  if (!isObj(input)) throw new Error("folders payload must be an object");
  for (const k of Object.keys(input)) {
    if (!ALLOWED_ROOT_KEYS.has(k)) throw new Error(`unknown folders field '${k}'`);
  }

  const rawFolders = input.folders ?? [];
  if (!Array.isArray(rawFolders)) throw new Error("folders must be an array");
  if (rawFolders.length > MAX_FOLDERS) throw new Error(`at most ${MAX_FOLDERS} folders allowed`);

  const folders = [];
  const folderIds = new Set();
  for (const raw of rawFolders) {
    if (!isObj(raw)) throw new Error("each folder must be an object");
    for (const k of Object.keys(raw)) {
      if (!ALLOWED_FOLDER_KEYS.has(k)) throw new Error(`unknown folder field '${k}'`);
    }
    const id = validateId(raw.id, FOLDER_ID_RE, "folder id");
    if (folderIds.has(id)) throw new Error(`duplicate folder id '${id}'`);
    folderIds.add(id);
    const name = validateFolderName(raw.name);
    if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") throw new Error("folder.pinned must be true or false");
    if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") throw new Error("folder.collapsed must be true or false");
    folders.push({
      id,
      name,
      pinned: raw.pinned === true,
      collapsed: raw.collapsed === true,
    });
  }

  const rawMap = input.chatFolder ?? {};
  if (!isObj(rawMap)) throw new Error("chatFolder must be an object");
  const chatFolder = {};
  for (const chatId of Object.keys(rawMap)) {
    validateId(chatId, CHAT_ID_RE, "chat id");
    const fid = rawMap[chatId];
    if (fid === null || fid === "") continue;
    if (typeof fid !== "string" || !folderIds.has(fid)) {
      throw new Error(`chatFolder['${chatId}'] references unknown folder '${fid}'`);
    }
    chatFolder[chatId] = fid;
  }

  const rawPinned = input.pinnedChats ?? [];
  if (!Array.isArray(rawPinned)) throw new Error("pinnedChats must be an array");
  const pinnedChats = [];
  const seenPinned = new Set();
  for (const chatId of rawPinned) {
    validateId(chatId, CHAT_ID_RE, "chat id");
    if (!seenPinned.has(chatId)) {
      seenPinned.add(chatId);
      pinnedChats.push(chatId);
    }
  }

  return { folders, chatFolder, pinnedChats };
}

/** Load per-project folders state. Never throws on missing or corrupt files. */
export function loadFolders(home) {
  try {
    return normalizeFolders(JSON.parse(fs.readFileSync(foldersFile(home), "utf8")));
  } catch {
    return emptyFolders();
  }
}

function writeFoldersAtomic(home, state) {
  fs.mkdirSync(home, { recursive: true });
  const file = foldersFile(home);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
  return state;
}

/** Validate and save a full folders state payload. */
export function saveFolders(home, input) {
  const normalized = normalizeFolders(input);
  return writeFoldersAtomic(home, normalized);
}

function makeFolderId(existingIds) {
  for (let i = 0; i < 16; i++) {
    const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error("could not allocate folder id");
}

/**
 * Apply a single validated folder mutation action and persist atomically.
 * Supported actions: create, rename, delete, collapse, pinFolder, moveChat, pinChat.
 */
export function applyFolderAction(home, body) {
  if (!isObj(body)) throw new Error("folders action payload must be an object");
  const { action } = body;
  if (typeof action !== "string" || !action) throw new Error("action must be a non-empty string");

  const cur = loadFolders(home);
  const folderById = new Map(cur.folders.map((f) => [f.id, f]));

  switch (action) {
    case "create": {
      if (cur.folders.length >= MAX_FOLDERS) throw new Error(`at most ${MAX_FOLDERS} folders allowed`);
      const name = validateFolderName(body.name);
      if (body.pinned !== undefined && typeof body.pinned !== "boolean") throw new Error("pinned must be true or false");
      const id = body.id !== undefined ? validateId(body.id, FOLDER_ID_RE, "folder id") : makeFolderId(new Set(folderById.keys()));
      if (folderById.has(id)) throw new Error(`duplicate folder id '${id}'`);
      cur.folders.push({ id, name, pinned: body.pinned === true, collapsed: false });
      return saveFolders(home, cur);
    }
    case "rename": {
      const id = validateId(body.id, FOLDER_ID_RE, "folder id");
      const folder = folderById.get(id);
      if (!folder) throw new Error(`unknown folder '${id}'`);
      folder.name = validateFolderName(body.name);
      return saveFolders(home, cur);
    }
    case "delete": {
      const id = validateId(body.id, FOLDER_ID_RE, "folder id");
      if (!folderById.has(id)) throw new Error(`unknown folder '${id}'`);
      cur.folders = cur.folders.filter((f) => f.id !== id);
      for (const cid of Object.keys(cur.chatFolder)) {
        if (cur.chatFolder[cid] === id) delete cur.chatFolder[cid];
      }
      return saveFolders(home, cur);
    }
    case "collapse": {
      const id = validateId(body.id, FOLDER_ID_RE, "folder id");
      const folder = folderById.get(id);
      if (!folder) throw new Error(`unknown folder '${id}'`);
      if (typeof body.collapsed !== "boolean") throw new Error("collapsed must be true or false");
      folder.collapsed = body.collapsed;
      return saveFolders(home, cur);
    }
    case "pinFolder": {
      const id = validateId(body.id, FOLDER_ID_RE, "folder id");
      const folder = folderById.get(id);
      if (!folder) throw new Error(`unknown folder '${id}'`);
      if (typeof body.pinned !== "boolean") throw new Error("pinned must be true or false");
      folder.pinned = body.pinned;
      return saveFolders(home, cur);
    }
    case "moveChat": {
      const chatId = validateId(body.chatId, CHAT_ID_RE, "chat id");
      const folderId = body.folderId ?? null;
      if (folderId === null || folderId === "") {
        delete cur.chatFolder[chatId];
      } else {
        validateId(folderId, FOLDER_ID_RE, "folder id");
        if (!folderById.has(folderId)) throw new Error(`unknown folder '${folderId}'`);
        cur.chatFolder[chatId] = folderId;
      }
      return saveFolders(home, cur);
    }
    case "pinChat": {
      const chatId = validateId(body.chatId, CHAT_ID_RE, "chat id");
      if (typeof body.pinned !== "boolean") throw new Error("pinned must be true or false");
      const next = cur.pinnedChats.filter((x) => x !== chatId);
      if (body.pinned) next.unshift(chatId);
      cur.pinnedChats = next;
      return saveFolders(home, cur);
    }
    default:
      throw new Error(`unknown folders action '${action}'`);
  }
}

/** Clean up folder/pin references when a chat is deleted. */
export function removeChatFromFolders(home, chatId) {
  if (!fs.existsSync(foldersFile(home))) return;
  try {
    const cur = loadFolders(home);
    let dirty = false;
    if (Object.hasOwn(cur.chatFolder, chatId)) {
      delete cur.chatFolder[chatId];
      dirty = true;
    }
    if (cur.pinnedChats.includes(chatId)) {
      cur.pinnedChats = cur.pinnedChats.filter((x) => x !== chatId);
      dirty = true;
    }
    if (dirty) writeFoldersAtomic(home, cur);
  } catch {}
}
