import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  detectDictationMode,
  parseBridgeMessage,
  encodeBridgeCall,
  formatDictationSegment,
  applyTranscriptToInput,
  createDictationController,
} from "../ui/dictation.js";
import { DICT, hasKey, t } from "../ui/i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeButton() {
  const attrs = new Map();
  const classes = new Set();
  return {
    hidden: false,
    title: "",
    classList: {
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
  };
}

function makeInput(value = "", selectionStart = value.length, selectionEnd = selectionStart) {
  return {
    value,
    selectionStart,
    selectionEnd,
    focused: false,
    focus() { this.focused = true; },
    setSelectionRange(s, e) {
      this.selectionStart = s;
      this.selectionEnd = e;
    },
  };
}

function makeComposer() {
  const classes = new Set();
  return {
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

test("detectDictationMode chooses native bridge, then Web Speech API, else none", () => {
  assert.equal(detectDictationMode({}), "none");
  assert.equal(detectDictationMode({ SpeechRecognition: function () {} }), "webspeech");
  assert.equal(detectDictationMode({ webkitSpeechRecognition: function () {} }), "webspeech");
  assert.equal(
    detectDictationMode({
      webkit: { messageHandlers: { tw: { postMessage() {} } } },
      SpeechRecognition: function () {},
    }),
    "native",
  );
});

test("encodeBridgeCall and parseBridgeMessage safely escape and round-trip special strings", () => {
  const payloads = [
    { type: "partial", text: `He said "hello", it's a \\path\\ and </script><script>alert(1)</script>` },
    { type: "final", text: "Line1\nLine2\r\nTab\tTurkish: ğüşiöç ĞÜŞİÖÇ 🚀" },
    { type: "final", text: "Separators:\u2028and\u2029end" },
  ];

  for (const payload of payloads) {
    const script = encodeBridgeCall(payload);
    assert.ok(!script.includes("\u2028"), "raw U+2028 must be escaped");
    assert.ok(!script.includes("\u2029"), "raw U+2029 must be escaped");

    let received = null;
    const sandbox = {
      window: {
        __twDictation: (arg) => { received = arg; },
      },
    };
    vm.runInNewContext(script, sandbox);
    assert.deepEqual({ ...received }, payload);
    assert.deepEqual({ ...parseBridgeMessage(received) }, payload);
    assert.deepEqual(parseBridgeMessage(JSON.stringify(payload)), payload);
  }

  assert.equal(parseBridgeMessage("not json"), null);
  assert.equal(parseBridgeMessage("[1,2,3]"), null);
  assert.equal(parseBridgeMessage(null), null);
});

test("cursor insertion: start, middle, selection replace, partial updates, and manual edit guard", () => {
  assert.equal(formatDictationSegment("", "hello", ""), "hello");
  assert.equal(formatDictationSegment("Fix", "the bug", ""), " the bug");
  assert.equal(formatDictationSegment("Fix ", "the bug", ""), "the bug");
  assert.equal(formatDictationSegment("Fix", "the bug", "now"), " the bug ");
  assert.equal(formatDictationSegment("Fix", ", please", "!"), ", please");

  // Insert in middle between "Fix " and " now"
  const input = makeInput("Fix  now", 4, 4);
  let span = applyTranscriptToInput(input, null, "the");
  assert.equal(input.value, "Fix the now");
  assert.equal(input.selectionStart, 7);

  // Cumulative partial replaces active span instead of duplicating
  span = applyTranscriptToInput(input, span, "the auth bug");
  assert.equal(input.value, "Fix the auth bug now");
  assert.equal(input.selectionStart, 16);

  // Final commits the span, so another dictation appends after it
  span = applyTranscriptToInput(input, span, "the auth bug!", { commit: true });
  assert.equal(input.value, "Fix the auth bug! now");
  assert.equal(input.selectionStart, 17);

  span = applyTranscriptToInput(input, span, "please", { commit: true });
  assert.equal(input.value, "Fix the auth bug! please now");

  // Selection replacement
  const selInput = makeInput("Fix old bug", 4, 7);
  applyTranscriptToInput(selInput, null, "new", { commit: true });
  assert.equal(selInput.value, "Fix new bug");
  assert.equal(selInput.selectionStart, 7);

  // Manual edit outside span re-anchors cleanly instead of clobbering
  const edited = makeInput("abc", 3, 3);
  let editSpan = applyTranscriptToInput(edited, null, "one");
  assert.equal(edited.value, "abc one");
  edited.value = "manual edit";
  edited.setSelectionRange(11, 11);
  editSpan = applyTranscriptToInput(edited, editSpan, "two", { commit: true });
  assert.equal(edited.value, "manual edit two");
});

test("native bridge controller handles start/stop, partial/final, pending final, and denied errors", () => {
  const posted = [];
  const errors = [];
  let changes = 0;
  let langSetting = "tr";

  const win = {
    webkit: {
      messageHandlers: {
        tw: { postMessage: (msg) => posted.push(msg) },
      },
    },
  };
  const input = makeInput("Merhaba ", 8, 8);
  const button = makeButton();
  const composer = makeComposer();

  const ctrl = createDictationController({
    win,
    input,
    button,
    composer,
    t: (k, v) => t(k, v, langSetting === "auto" ? "en" : langSetting),
    getLang: () => (langSetting === "auto" ? undefined : "tr-TR"),
    onError: (msg) => errors.push(msg),
    onChange: () => { changes += 1; },
  });

  assert.equal(ctrl.mode, "native");
  assert.equal(button.hidden, false);
  assert.equal(typeof win.__twDictation, "function");

  ctrl.start();
  assert.equal(ctrl.isActive(), true);
  assert.equal(button.classList.contains("recording"), true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(composer.classList.contains("dictating"), true);
  assert.deepEqual(posted.at(-1), { type: "dictation", action: "start", lang: "tr-TR" });

  win.__twDictation({ type: "started", locale: "tr-TR", onDevice: true });
  win.__twDictation({ type: "partial", text: "testleri" });
  assert.equal(input.value, "Merhaba testleri");
  win.__twDictation({ type: "partial", text: "testleri çalıştır" });
  assert.equal(input.value, "Merhaba testleri çalıştır");

  // User stops (e.g. Esc): UI goes idle immediately and sends stop
  ctrl.stop();
  assert.equal(ctrl.isActive(), false);
  assert.equal(button.classList.contains("recording"), false);
  assert.equal(composer.classList.contains("dictating"), false);
  assert.deepEqual(posted.at(-1), { type: "dictation", action: "stop" });

  // Late partial after stop is ignored, while pending final refines and commits
  win.__twDictation({ type: "partial", text: "ignored" });
  assert.equal(input.value, "Merhaba testleri çalıştır");
  win.__twDictation({ type: "final", text: "testleri çalıştır." });
  assert.equal(input.value, "Merhaba testleri çalıştır.");
  win.__twDictation({ type: "stopped" });
  assert.ok(changes >= 3);

  // Auto language omits lang so Swift falls back to studio/system settings
  langSetting = "auto";
  ctrl.start();
  assert.deepEqual(posted.at(-1), { type: "dictation", action: "start" });

  // Permission denied shows clear localized message and resets state
  win.__twDictation({ type: "error", code: "mic_denied", message: "raw" });
  assert.equal(ctrl.isActive(), false);
  assert.equal(button.classList.contains("recording"), false);
  assert.equal(errors.at(-1), t("composer.dictateDeniedMic", {}, "en"));

  ctrl.start();
  win.__twDictation({ type: "error", code: "speech_denied", message: "raw" });
  assert.equal(errors.at(-1), t("composer.dictateDeniedSpeech", {}, "en"));
});

test("browser mode hides mic when unsupported and uses Web Speech API when available", () => {
  const hiddenBtn = makeButton();
  const noneCtrl = createDictationController({
    win: {},
    input: makeInput(),
    button: hiddenBtn,
    t: (k, v) => t(k, v, "en"),
  });
  assert.equal(noneCtrl.mode, "none");
  assert.equal(hiddenBtn.hidden, true);
  assert.equal(noneCtrl.start(), false);

  const instances = [];
  class MockSpeechRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = "";
      this.stopped = false;
      instances.push(this);
    }
    start() {}
    stop() { this.stopped = true; }
  }

  const errors = [];
  const input = makeInput("", 0, 0);
  const button = makeButton();
  const win = {
    webkitSpeechRecognition: MockSpeechRecognition,
    navigator: { language: "en-US" },
  };
  const webCtrl = createDictationController({
    win,
    input,
    button,
    t: (k, v) => t(k, v, "en"),
    getLang: () => undefined,
    onError: (m) => errors.push(m),
  });

  assert.equal(webCtrl.mode, "webspeech");
  assert.equal(button.hidden, false);

  webCtrl.toggle();
  assert.equal(webCtrl.isActive(), true);
  const rec = instances[0];
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.lang, "en-US");

  rec.onresult({
    results: [
      { isFinal: true, 0: { transcript: "Fix" } },
      { isFinal: false, 0: { transcript: "the tests" } },
    ],
  });
  assert.equal(input.value, "Fix the tests");

  webCtrl.toggle();
  assert.equal(rec.stopped, true);
  assert.equal(webCtrl.isActive(), false);
  rec.onend();

  // Error mapping for browser permission denial
  webCtrl.start();
  instances[1].onerror({ error: "not-allowed" });
  assert.equal(webCtrl.isActive(), false);
  assert.equal(errors.at(-1), t("composer.dictateDeniedBrowser", {}, "en"));
});

test("dictation i18n keys, Swift bridge, Info.plist, and UI server route are wired", async () => {
  const dictJs = fs.readFileSync(path.join(ROOT, "ui", "dictation.js"), "utf8");
  for (const m of dictJs.matchAll(/\bt\(\s*["']([^"'${}]+)["']/g)) {
    const key = m[1];
    assert.equal(hasKey(key, "en"), true, `missing en key in ui/dictation.js: ${key}`);
    assert.equal(hasKey(key, "tr"), true, `missing tr key in ui/dictation.js: ${key}`);
  }
  assert.ok(DICT.en["composer.dictate"]);
  assert.ok(DICT.tr["composer.dictate"]);

  const cliJs = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  assert.ok(cliJs.includes('"-framework", "Speech"'));
  assert.ok(cliJs.includes('"-framework", "AVFoundation"'));
  assert.ok(cliJs.includes("NSMicrophoneUsageDescription"));
  assert.ok(cliJs.includes("NSSpeechRecognitionUsageDescription"));

  const swift = fs.readFileSync(path.join(ROOT, "launcher", "TokenwiseStudio.swift"), "utf8");
  assert.ok(swift.includes("SFSpeechRecognizer"));
  assert.ok(swift.includes("AVAudioEngine"));
  assert.ok(swift.includes("requiresOnDeviceRecognition"));
  assert.ok(swift.includes("window.__twDictation"));
  assert.ok(swift.includes("JSONSerialization.data(withJSONObject:"));

  const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
  assert.ok(html.includes('id="mic"'));
  assert.ok(html.includes('import { createDictationController } from "/dictation.js"'));
  assert.ok(html.includes('e.key === "Escape" && dictation?.isActive()'));

  // Serve /dictation.js via ui.js handler on a temp repo & temp HOME
  const prevHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tw-dict-home-"));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-dict-repo-"));
  process.env.HOME = tmpHome;
  try {
    const { initServer, handler } = await import("../src/ui.js");
    initServer({ repo: tmpRepo });
    let status = 200;
    let headers = {};
    const chunks = [];
    const res = {
      writeHead(code, h = {}) { status = code; headers = h; },
      end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
    };
    await handler({ method: "GET", url: "/dictation.js", headers: { host: "127.0.0.1:4790" } }, res);
    assert.equal(status, 200);
    assert.match(headers["content-type"] || "", /javascript/);
    const body = Buffer.concat(chunks).toString("utf8");
    assert.ok(body.includes("createDictationController"));
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
