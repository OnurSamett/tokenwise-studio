// Dependency-free composer dictation controller (native macOS WKWebView bridge + Web Speech API fallback).

/**
 * Detect which dictation backend is available in the current window.
 * Prefers the native macOS WKWebView bridge over browser Web Speech API.
 * @param {any} [win]
 * @returns {"native" | "webspeech" | "none"}
 */
export function detectDictationMode(win = globalThis) {
  if (typeof win?.webkit?.messageHandlers?.tw?.postMessage === "function") return "native";
  if (typeof (win?.SpeechRecognition || win?.webkitSpeechRecognition) === "function") return "webspeech";
  return "none";
}

/**
 * Parse a payload delivered to window.__twDictation(...).
 * Accepts either a plain object (from evaluateJavaScript JSON literal) or a JSON string.
 * @param {any} raw
 * @returns {Record<string, any> | null}
 */
export function parseBridgeMessage(raw) {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return null;
}

/**
 * JSON-encode a dictation payload into a safe evaluateJavaScript call.
 * Escapes U+2028/U+2029 so JS evaluation never treats them as line terminators.
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function encodeBridgeCall(payload) {
  const json = JSON.stringify(payload)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__twDictation && window.__twDictation(${json})`;
}

/**
 * Add smart boundary spacing around a transcribed segment relative to surrounding text.
 * @param {string} before
 * @param {string} text
 * @param {string} after
 * @returns {string}
 */
export function formatDictationSegment(before, text, after = "") {
  const clean = String(text ?? "");
  if (!clean) return "";
  const needLead = before.length > 0 && !/\s$/.test(before) && !/^[\s.,!?;:)\]}]/.test(clean);
  const needTrail = after.length > 0 && !/^\s/.test(after) && !/[\s(\[{]$/.test(clean) && !/^[.,!?;:)\]}]/.test(after);
  return `${needLead ? " " : ""}${clean}${needTrail ? " " : ""}`;
}

/**
 * Snapshot the current selection/cursor range in a textarea.
 * @param {{ value: string, selectionStart?: number | null, selectionEnd?: number | null }} input
 * @returns {{ start: number, end: number, before: string, after: string }}
 */
export function createSpanFromInput(input) {
  const value = String(input?.value ?? "");
  const start = typeof input?.selectionStart === "number" ? input.selectionStart : value.length;
  const end = typeof input?.selectionEnd === "number" ? input.selectionEnd : start;
  const lo = Math.max(0, Math.min(start, value.length));
  const hi = Math.max(lo, Math.min(end, value.length));
  return {
    start: lo,
    end: hi,
    before: value.slice(0, lo),
    after: value.slice(hi),
  };
}

/**
 * Insert or update transcribed text at the active cursor span inside a textarea.
 * Re-anchors automatically if the user edited text outside the active span.
 * @param {{ value: string, selectionStart?: number | null, selectionEnd?: number | null, setSelectionRange?: (s: number, e: number) => void }} input
 * @param {{ start: number, end: number, before: string, after: string }} span
 * @param {string} rawText
 * @param {{ commit?: boolean }} [opts]
 * @returns {{ start: number, end: number, before: string, after: string }}
 */
export function applyTranscriptToInput(input, span, rawText, { commit = false } = {}) {
  const cur = String(input?.value ?? "");
  let active = span;
  if (!active || cur.slice(0, active.start) !== active.before || cur.slice(active.end) !== active.after) {
    active = createSpanFromInput(input);
  }
  const inserted = formatDictationSegment(active.before, rawText, active.after);
  const nextValue = active.before + inserted + active.after;
  const caret = active.start + inserted.length;
  input.value = nextValue;
  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(caret, caret);
  } else {
    input.selectionStart = caret;
    input.selectionEnd = caret;
  }
  if (commit) {
    return {
      start: caret,
      end: caret,
      before: nextValue.slice(0, caret),
      after: nextValue.slice(caret),
    };
  }
  return {
    start: active.start,
    end: caret,
    before: active.before,
    after: active.after,
  };
}

/**
 * Create a composer dictation controller wired to either the native WKWebView bridge
 * or the browser Web Speech API. Hides the mic button when neither is available.
 */
export function createDictationController({
  win = globalThis,
  input,
  button,
  composer = null,
  t = (k) => k,
  getLang = () => undefined,
  onError = () => {},
  onChange = () => {},
} = {}) {
  const mode = detectDictationMode(win);
  let state = "idle"; // "idle" | "starting" | "recording"
  let pendingFinal = false;
  let span = null;
  let activeRec = null;
  let userStoppedRec = false;

  const isActive = () => state !== "idle";

  function syncUi() {
    if (!button) return;
    button.hidden = mode === "none";
    const active = isActive();
    button.classList.toggle("recording", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const label = active ? t("composer.dictateStop") : t("composer.dictate");
    button.title = label;
    button.setAttribute("aria-label", label);
    composer?.classList.toggle("dictating", active);
  }

  function mapBridgeError(msg) {
    const code = String(msg?.code || "").toLowerCase();
    if (code === "mic_denied") return t("composer.dictateDeniedMic");
    if (code === "speech_denied") return t("composer.dictateDeniedSpeech");
    if (code === "denied") return msg?.message || t("composer.dictateDeniedMic");
    if (code === "unavailable") return msg?.message || t("composer.dictateUnavailable");
    return msg?.message ? t("composer.dictateFailed", { message: msg.message }) : t("composer.dictateUnavailable");
  }

  function finishToIdle() {
    state = "idle";
    syncUi();
  }

  function handleBridgeMessage(raw) {
    const msg = parseBridgeMessage(raw);
    if (!msg) return false;
    const type = String(msg.type || "").toLowerCase();

    if (type === "started") {
      if (isActive()) {
        state = "recording";
        syncUi();
      }
      return true;
    }

    if (type === "partial") {
      if (!isActive() || !input) return false;
      span = applyTranscriptToInput(input, span, msg.text ?? "", { commit: false });
      onChange();
      return true;
    }

    if (type === "final") {
      if ((!isActive() && !pendingFinal) || !input) return false;
      span = applyTranscriptToInput(input, span, msg.text ?? "", { commit: true });
      pendingFinal = false;
      onChange();
      return true;
    }

    if (type === "stopped") {
      pendingFinal = false;
      if (span && input) {
        span = {
          start: span.end,
          end: span.end,
          before: String(input.value ?? "").slice(0, span.end),
          after: String(input.value ?? "").slice(span.end),
        };
      }
      finishToIdle();
      return true;
    }

    if (type === "error") {
      const wasActive = isActive();
      pendingFinal = false;
      finishToIdle();
      if (wasActive) onError(mapBridgeError(msg));
      return true;
    }

    return false;
  }

  if (mode === "native") {
    win.__twDictation = handleBridgeMessage;
  }

  function startNative() {
    span = createSpanFromInput(input);
    if (typeof input?.focus === "function") input.focus();
    pendingFinal = false;
    state = "starting";
    syncUi();
    const langHint = getLang();
    const payload = langHint ? { type: "dictation", action: "start", lang: langHint } : { type: "dictation", action: "start" };
    try {
      win.webkit.messageHandlers.tw.postMessage(payload);
    } catch (e) {
      finishToIdle();
      onError(t("composer.dictateFailed", { message: e?.message || String(e) }));
    }
  }

  function stopNative() {
    if (!isActive()) return;
    pendingFinal = true;
    finishToIdle();
    try {
      win.webkit.messageHandlers.tw.postMessage({ type: "dictation", action: "stop" });
    } catch {}
  }

  function startWebSpeech() {
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRec) return;
    span = createSpanFromInput(input);
    if (typeof input?.focus === "function") input.focus();
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    const langHint = getLang() || win.navigator?.language;
    if (langHint) rec.lang = langHint;
    activeRec = rec;
    userStoppedRec = false;
    state = "recording";
    syncUi();

    rec.onresult = (event) => {
      if (rec !== activeRec || !input) return;
      let transcript = "";
      for (let i = 0; i < (event?.results?.length || 0); i++) {
        const res = event.results[i];
        const piece = res?.[0]?.transcript || "";
        if (!piece) continue;
        if (transcript && !/\s$/.test(transcript) && !/^[\s.,!?;:)\]}]/.test(piece)) {
          transcript += " ";
        }
        transcript += piece;
      }
      span = applyTranscriptToInput(input, span, transcript, { commit: false });
      onChange();
    };

    rec.onerror = (event) => {
      if (rec !== activeRec) return;
      const err = String(event?.error || "");
      const wasStopped = userStoppedRec;
      activeRec = null;
      finishToIdle();
      if (wasStopped && err === "aborted") return;
      if (err === "no-speech") return;
      if (err === "not-allowed" || err === "service-not-allowed") {
        onError(t("composer.dictateDeniedBrowser"));
      } else if (err === "audio-capture") {
        onError(t("composer.dictateUnavailable"));
      } else {
        onError(t("composer.dictateFailed", { message: err || "error" }));
      }
    };

    rec.onend = () => {
      if (rec !== activeRec) return;
      activeRec = null;
      if (span && input) {
        span = {
          start: span.end,
          end: span.end,
          before: String(input.value ?? "").slice(0, span.end),
          after: String(input.value ?? "").slice(span.end),
        };
      }
      finishToIdle();
    };

    try {
      rec.start();
    } catch (e) {
      activeRec = null;
      finishToIdle();
      onError(t("composer.dictateFailed", { message: e?.message || String(e) }));
    }
  }

  function stopWebSpeech() {
    const rec = activeRec;
    if (!rec) {
      finishToIdle();
      return;
    }
    userStoppedRec = true;
    finishToIdle();
    try {
      rec.stop();
    } catch {
      activeRec = null;
    }
  }

  function start() {
    if (mode === "none" || isActive()) return false;
    if (mode === "native") startNative();
    else startWebSpeech();
    return true;
  }

  function stop() {
    if (!isActive()) return false;
    if (mode === "native") stopNative();
    else stopWebSpeech();
    return true;
  }

  function toggle() {
    return isActive() ? stop() : start();
  }

  syncUi();

  return {
    mode,
    isActive,
    start,
    stop,
    toggle,
    updateLabels: syncUi,
    handleBridgeMessage,
  };
}
