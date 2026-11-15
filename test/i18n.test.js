import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_LANGUAGES,
  DICT,
  resolveLanguage,
  hasKey,
  t,
  tp,
  translateReason,
  translateNotice,
} from "../ui/i18n.js";
import { LANGUAGES, DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import { jobNotice, turnNotice, handoffNotice } from "../src/notify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractVars(str) {
  const matches = str.match(/\{[a-zA-Z0-9_]+\}/g) || [];
  return [...new Set(matches)].sort();
}

test("i18n dictionaries: matching keys, non-empty strings, and matching placeholders", () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ["en", "tr", "es", "de", "fr"]);
  const enKeys = Object.keys(DICT.en).sort();
  for (const language of SUPPORTED_LANGUAGES) assert.deepEqual(Object.keys(DICT[language]).sort(), enKeys, `dictionary keys: ${language}`);

  for (const key of enKeys) {
    assert.equal(hasKey(key, "en"), true, `hasKey(en) missing ${key}`);
    assert.equal(hasKey(key, "tr"), true, `hasKey(tr) missing ${key}`);
    for (const lang of SUPPORTED_LANGUAGES) {
      const val = DICT[lang][key];
      assert.equal(typeof val, "string", `${lang}.${key} must be a string`);
      assert.ok(val.trim().length > 0, `${lang}.${key} must not be empty`);
    }
    for (const language of SUPPORTED_LANGUAGES) assert.deepEqual(extractVars(DICT[language][key]), extractVars(DICT.en[key]), `placeholder mismatch for ${language}.${key}`);
  }
});

test("all static i18n keys referenced in ui/index.html and src/notify.js exist in both dictionaries", () => {
  const uiHtml = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
  const notifyJs = fs.readFileSync(path.join(ROOT, "src", "notify.js"), "utf8");

  for (const src of [uiHtml, notifyJs]) {
    for (const m of src.matchAll(/\bt\(\s*["']([^"'${}]+)["']/g)) {
      const key = m[1];
      assert.equal(hasKey(key, "en"), true, `missing en key from t(): ${key}`);
      assert.equal(hasKey(key, "tr"), true, `missing tr key from t(): ${key}`);
    }
    for (const m of src.matchAll(/\btp\(\s*["']([^"'${}]+)["']/g)) {
      const base = m[1];
      for (const suffix of ["one", "other"]) {
        assert.equal(hasKey(`${base}.${suffix}`, "en"), true, `missing en plural key: ${base}.${suffix}`);
        assert.equal(hasKey(`${base}.${suffix}`, "tr"), true, `missing tr plural key: ${base}.${suffix}`);
      }
    }
  }

  for (const m of uiHtml.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    const key = m[1];
    assert.equal(hasKey(key, "en"), true, `missing en data-i18n key: ${key}`);
    assert.equal(hasKey(key, "tr"), true, `missing tr data-i18n key: ${key}`);
  }
});

test("t(), tp(), and resolveLanguage() work across en, tr, and auto", () => {
  assert.equal(resolveLanguage("en"), "en");
  assert.equal(tp("teamCard.delegated", 0, {}, "fr"), t("teamCard.delegated.one", { n: 0 }, "fr"));
  assert.equal(tp("teamCard.delegated", 2, {}, "fr"), t("teamCard.delegated.other", { n: 2 }, "fr"));
  assert.equal(resolveLanguage("tr"), "tr");
  for (const lang of ["es", "de", "fr"]) {
    assert.equal(resolveLanguage(lang), lang);
    assert.equal(resolveLanguage("auto", { navigatorLang: `${lang}-${lang.toUpperCase()}` }), lang);
  }
  assert.equal(resolveLanguage("auto", { navigatorLang: "tr-TR" }), "tr");
  assert.equal(resolveLanguage("auto", { navigatorLang: "tr" }), "tr");
  assert.equal(resolveLanguage("auto", { navigatorLang: "en-US" }), "en");
  assert.equal(resolveLanguage("auto", { navigatorLang: "", env: { LANG: "tr_TR.UTF-8" } }), "tr");
  assert.equal(resolveLanguage("auto", { navigatorLang: "", env: {}, intlLocale: "tr-TR" }), "tr");
  assert.equal(resolveLanguage("auto", { navigatorLang: "", env: {}, intlLocale: "en-GB" }), "en");

  assert.equal(t("side.newTask", {}, "tr"), "Yeni görev");
  assert.equal(t("side.newTask", {}, "en"), "New task");
  assert.equal(t("review.meta", { files: "3 dosya", workers: "2 çalışan" }, "tr"), "2 çalışan tarafından 3 dosya");
  assert.equal(tp("review.files", 1, {}, "tr"), "1 dosya");
  assert.equal(tp("review.files", 4, {}, "tr"), "4 dosya");
  assert.equal(tp("review.files", 1, {}, "en"), "1 file");
  assert.equal(tp("review.files", 4, {}, "en"), "4 files");
  assert.equal(t("unknown.missing.key", {}, "tr"), "unknown.missing.key");
});

test("translateReason() and translateNotice() localize dynamic backend messages", () => {
  assert.equal(translateReason("hit a rate limit", "tr"), "hız limitine takıldı");
  assert.equal(translateReason("5-hour limit at 94%", "tr"), "5 saatlik limit %94");
  assert.equal(translateReason("weekly limit at 88%", "tr"), "haftalık limit %88");
  assert.equal(translateReason("claude not available", "tr"), "claude kullanılamıyor");
  assert.equal(translateReason("Claude is not available", "tr"), "Claude kullanılamıyor");
  assert.equal(translateReason("chosen by user", "tr"), "sen seçtin");
  assert.equal(translateReason("hit a rate limit", "en"), "hit a rate limit");

  const trWarn = translateNotice("Turn budget at 95% (47.5K of 50K tokens). New jobs stop at 100%.", "tr");
  assert.equal(trWarn, "Tur bütçesi %95 seviyesinde (47.5K / 50K token). %100'de yeni işler durur.");

  const trReached = translateNotice("Turn budget reached (50K of 50K tokens). No new jobs will start.", "tr");
  assert.equal(trReached, "Tur bütçesine ulaşıldı (50K / 50K token). Bu turda yeni iş başlatılmayacak; çalışan işler devam ediyor.");
});

test("settings.js validates and persists language setting in temp HOME", () => {
  assert.deepEqual(LANGUAGES, ["auto", "en", "tr", "es", "de", "fr"]);
  assert.equal(DEFAULTS.language, "auto");

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tw-i18n-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    assert.equal(loadSettings().language, "auto");

    const savedTr = saveSettings({ language: "tr" });
    assert.equal(savedTr.language, "tr");
    assert.equal(loadSettings().language, "tr");

    const savedEn = saveSettings({ language: "en" });
    assert.equal(savedEn.language, "en");

    const savedAuto = saveSettings({ language: "auto" });
    assert.equal(savedAuto.language, "auto");

    for (const language of ["es", "de", "fr"]) {
      assert.equal(saveSettings({ language }).language, language);
      assert.equal(loadSettings().language, language);
    }
    assert.throws(() => saveSettings({ language: "it" }), /language must be one of auto, en, tr, es, de, fr/);
    assert.throws(() => saveSettings({ language: 123 }), /language must be one of auto, en, tr, es, de, fr/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("notify.js localizes desktop notification titles and messages without translating agent names", () => {
  const trRead = jobNotice({ id: "j0", status: "done", agent: "codex" }, 0, { lang: "tr" });
  assert.equal(trRead.title, "Çalışan bitirdi");
  assert.ok(trRead.message.startsWith("Codex:"));

  const trWrite = jobNotice({ id: "j1", status: "done", agent: "codex", write: true, diffStat: "src/a.js | 2 +-\n", title: "Fix auth" }, 2, { lang: "tr" });
  assert.equal(trWrite.title, "İncelemeye hazır");
  assert.ok(trWrite.message.includes("Codex"));
  assert.ok(trWrite.message.includes("2 dosya değişti"));

  const enWrite = jobNotice({ id: "j2", status: "done", agent: "codex", write: true, diffStat: "src/a.js | 2 +-\n", title: "Fix auth" }, 2, { lang: "en" });
  assert.equal(enWrite.title, "Ready for review");
  assert.ok(enWrite.message.includes("Codex"));
  assert.ok(enWrite.message.includes("2 files changed"));

  const trTurn = turnNotice({
    turn: "t1",
    chatTitle: "Auth fix",
    readyJobs: 1,
    lang: "tr",
  });
  assert.equal(trTurn.title, "Yönetici bitirdi");
  assert.equal(trTurn.subtitle, "Auth fix");
  assert.ok(trTurn.message.includes("1 iş incelemeye hazır"));

  const trHandoff = handoffNotice("weekly limit at 95%", { lang: "tr" });
  assert.equal(trHandoff.title, "Codex devraldı");
  assert.ok(trHandoff.message.includes("Claude haftalık limit %95"));
});

test("ui/index.html inline module script has valid JS syntax", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "Expected <script type=\"module\"> in ui/index.html");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-html-js-"));
  const tmpJs = path.join(tmpDir, "inline.mjs");
  try {
    fs.writeFileSync(tmpJs, match[1]);
    execFileSync(process.execPath, ["--check", tmpJs], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
