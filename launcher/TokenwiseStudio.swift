// tokenwise studio app executable. Compiled by `tokenwise-studio setup` into
// tokenwise studio.app/Contents/MacOS/tokenwise-studio.
//   --notify --title T --message M [--subtitle S] [--repo PATH]   post a notification, then exit
//   --open-url URL --repo PATH     open a window for an already running server
//   --print-state                  print parsed app-state and recents as JSON, then exit
//   tokenwise-studio://open?repo=<path>&url=<url>   same, via the URL scheme (works if already running)
//   (no args)  regular Dock app: restore last project windows, or open the Welcome window
import AppKit
import WebKit
import UserNotifications
import Speech
import AVFoundation

let resources = Bundle.main.resourcePath ?? ""
let homeDirURL: URL = {
    if let envHome = ProcessInfo.processInfo.environment["HOME"], !envHome.isEmpty {
        return URL(fileURLWithPath: (envHome as NSString).standardizingPath, isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser
}()
let stateDir = homeDirURL.appendingPathComponent(".tokenwise-studio", isDirectory: true)
let appStateURL = stateDir.appendingPathComponent("app-state.json")
let recentsURL = stateDir.appendingPathComponent("recents.json")
let logURL = stateDir.appendingPathComponent("launcher.log")

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("tokenwise-studio: \(msg)\n".utf8))
    exit(1)
}

// MARK: - servers

func isLocalHost(_ h: String?) -> Bool {
    guard let h = h?.lowercased() else { return false }
    return h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]"
}

func readServers() -> [String: String] {
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("servers.json")),
          let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
    return map
}

struct WindowFrameData: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var nsRect: NSRect { NSRect(x: x, y: y, width: width, height: height) }
    var isValid: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite && width >= 900 && height >= 600
    }
}

struct SavedWindowState: Codable {
    let repo: String
    var frame: WindowFrameData?
}

struct AppState: Codable {
    var windows: [SavedWindowState]
    var lastOpened: [String: Double]?
}

struct RecentEntry {
    let path: String
    let name: String
    let shortPath: String
    let isGit: Bool
    let lastOpened: Double?
}

func isExistingDirectory(_ path: String) -> Bool {
    var d: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &d) && d.boolValue
}

func shortenHomePath(_ path: String) -> String {
    let std = (path as NSString).standardizingPath
    let home = (homeDirURL.path as NSString).standardizingPath
    if std == home { return "~" }
    if home != "/" && std.hasPrefix(home + "/") {
        return "~" + String(std.dropFirst(home.count))
    }
    return std
}

func isGitRepository(_ path: String) -> Bool {
    var cur = (path as NSString).standardizingPath
    let fm = FileManager.default
    while !cur.isEmpty {
        let dotGit = (cur as NSString).appendingPathComponent(".git")
        if fm.fileExists(atPath: dotGit) { return true }
        let parent = (cur as NSString).deletingLastPathComponent
        if parent == cur || parent.isEmpty { break }
        cur = parent
    }
    return false
}

func inferredLastOpenedMs(_ path: String) -> Double? {
    let fm = FileManager.default
    let candidates = [
        (path as NSString).appendingPathComponent(".tokenwise-studio/chats"),
        (path as NSString).appendingPathComponent(".tokenwise-studio/jobs"),
        (path as NSString).appendingPathComponent(".tokenwise-studio"),
    ]
    var best: Double? = nil
    for c in candidates {
        if let attrs = try? fm.attributesOfItem(atPath: c),
           let mod = attrs[.modificationDate] as? Date {
            let ms = mod.timeIntervalSince1970 * 1000
            if best == nil || ms > best! { best = ms }
        }
    }
    return best
}

func parseTimestampMs(_ val: Any?) -> Double? {
    if let n = val as? Double, n.isFinite, n > 0 {
        return n < 100_000_000_000 ? n * 1000 : n
    }
    if let n = val as? Int, n > 0 {
        let d = Double(n)
        return d < 100_000_000_000 ? d * 1000 : d
    }
    if let s = val as? String, !s.isEmpty {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let dt = iso.date(from: s) { return dt.timeIntervalSince1970 * 1000 }
        iso.formatOptions = [.withInternetDateTime]
        if let dt = iso.date(from: s) { return dt.timeIntervalSince1970 * 1000 }
    }
    return nil
}

func readAppState() -> AppState {
    guard let data = try? Data(contentsOf: appStateURL),
          let decoded = try? JSONDecoder().decode(AppState.self, from: data) else {
        return AppState(windows: [], lastOpened: [:])
    }
    return AppState(windows: decoded.windows, lastOpened: decoded.lastOpened ?? [:])
}

func writeAppState(_ state: AppState) {
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? enc.encode(state) else { return }
    try? data.write(to: appStateURL, options: .atomic)
}

func rememberRecent(_ repo: String) {
    let std = (repo as NSString).standardizingPath
    var existing: [String] = []
    if let data = try? Data(contentsOf: recentsURL),
       let raw = try? JSONSerialization.jsonObject(with: data) as? [Any] {
        for item in raw {
            if let s = item as? String {
                existing.append((s as NSString).standardizingPath)
            } else if let obj = item as? [String: Any], let s = obj["path"] as? String {
                existing.append((s as NSString).standardizingPath)
            }
        }
    }
    var list = [std]
    for p in existing where p != std && !list.contains(p) {
        list.append(p)
        if list.count >= 8 { break }
    }
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    guard let data = try? JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted]) else { return }
    try? data.write(to: recentsURL, options: .atomic)
}

func readRecentEntries(appState: AppState? = nil) -> [RecentEntry] {
    guard let data = try? Data(contentsOf: recentsURL),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
    let st = appState ?? readAppState()
    var seen = Set<String>()
    var out: [RecentEntry] = []
    for item in raw {
        let rawPath: String?
        var explicitTs: Double? = nil
        if let s = item as? String {
            rawPath = s
        } else if let obj = item as? [String: Any], let s = obj["path"] as? String {
            rawPath = s
            explicitTs = parseTimestampMs(obj["lastOpened"] ?? obj["openedAt"])
        } else {
            rawPath = nil
        }
        guard let p = rawPath, !p.isEmpty else { continue }
        let std = (p as NSString).standardizingPath
        guard !seen.contains(std), isExistingDirectory(std) else { continue }
        seen.insert(std)
        let ts = explicitTs ?? st.lastOpened?[std] ?? st.lastOpened?[p] ?? inferredLastOpenedMs(std)
        let name = (std as NSString).lastPathComponent
        out.append(RecentEntry(
            path: std,
            name: name.isEmpty ? std : name,
            shortPath: shortenHomePath(std),
            isGit: isGitRepository(std),
            lastOpened: ts
        ))
    }
    return out
}

func readRecents() -> [String] {
    readRecentEntries().map { $0.path }
}

/// The version this app was built for (written into Info.plist by `tokenwise-studio setup`).
let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""

/// Record this bundle's path in ~/.tokenwise-studio/app.json so Node processes can find it even after a move.
func recordAppPath() {
    let bundlePath = Bundle.main.bundlePath
    guard bundlePath.hasSuffix(".app"),
          Bundle.main.bundleIdentifier == "com.nolienlabs.tokenwise-studio" else { return }
    let file = stateDir.appendingPathComponent("app.json")
    if let existing = try? Data(contentsOf: file),
       let obj = try? JSONSerialization.jsonObject(with: existing) as? [String: Any],
       (obj["bundlePath"] as? String) == bundlePath {
        return
    }
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    let payload: [String: Any] = ["bundlePath": bundlePath, "bundleId": "com.nolienlabs.tokenwise-studio"]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) else { return }
    try? data.write(to: file, options: .atomic)
}

func logLine(_ msg: String) {
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    let line = "\(Date()) app: \(msg)\n"
    if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
    else { try? line.write(to: logURL, atomically: true, encoding: .utf8) }
}

/// Blocking health check that also reads the version the server was started with (call off the main thread).
func serverState(_ base: URL) -> (ok: Bool, version: String?) {
    var req = URLRequest(url: base.appendingPathComponent("api/state"), timeoutInterval: 1)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var version: String? = nil
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let h = resp as? HTTPURLResponse, h.statusCode == 200 {
            ok = true
            if let d = data, let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { version = o["version"] as? String }
        }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 1.5)
    return (ok, version)
}

func healthy(_ base: URL) -> Bool { serverState(base).ok }

/// Ask a studio server to exit (CSRF header required by the server). True when it agreed.
func quitServer(_ base: URL) -> Bool {
    var req = URLRequest(url: base.appendingPathComponent("api/quit"), timeoutInterval: 2)
    req.httpMethod = "POST"
    req.setValue("1", forHTTPHeaderField: "x-tokenwise")
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = Data("{}".utf8)
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let h = resp as? HTTPURLResponse, h.statusCode == 200 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2.5)
    return ok
}

func registeredServer(for repo: String) -> URL? {
    guard let s = readServers()[repo], let base = URL(string: s), isLocalHost(base.host), healthy(base) else { return nil }
    return base
}

func spawnServer(repo: String) -> Bool {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: resources + "/config.json")),
          let cfg = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let node = cfg["node"], let cli = cfg["cli"] else { return false }
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    // nohup + background so the server outlives this app
    p.arguments = ["-c", "nohup \"$@\" >> \"$TWS_LOG\" 2>&1 < /dev/null &", "sh", node, cli, repo, "--no-open"]
    var env = ProcessInfo.processInfo.environment
    let nodeDir = (node as NSString).deletingLastPathComponent
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(nodeDir):" + (env["PATH"] ?? "/usr/bin:/bin")
    env["TWS_LOG"] = logURL.path
    p.environment = env
    do { try p.run(); p.waitUntilExit(); return true } catch { return false }
}

/// Existing server for the repo, or start one and wait up to ~15s. Blocking.
/// A registered server started by an older version (different from this app's) is stale: it serves the
/// current page files but lacks newer routes, which leaves a dead UI. Ask it to quit and start a fresh one.
func ensureServer(repo: String) -> URL? {
    var stale: URL? = nil
    if let s = readServers()[repo], let base = URL(string: s), isLocalHost(base.host) {
        let st = serverState(base)
        if st.ok {
            if st.version == appVersion || appVersion.isEmpty { return base }
            logLine("server at \(base.absoluteString) runs \(st.version ?? "an unknown version"), app is \(appVersion): replacing it")
            stale = base
            if quitServer(base) {
                let gone = Date().addingTimeInterval(3)
                while Date() < gone && serverState(base).ok { Thread.sleep(forTimeInterval: 0.2) }
            }
        }
    }
    guard spawnServer(repo: repo) else { return nil }
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.4)
        if let u = registeredServer(for: repo), u != stale { return u }
    }
    return nil
}

/// Only plain http to the local machine, and an existing directory.
func validate(repo: String?, url: String?) -> (repo: String, url: URL?)? {
    guard let repo = repo, !repo.isEmpty else { return nil }
    let path = (repo as NSString).standardizingPath
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return nil }
    var u: URL? = nil
    if let s = url, !s.isEmpty {
        guard let parsed = URL(string: s), parsed.scheme == "http", isLocalHost(parsed.host) else { return nil }
        u = parsed
    }
    return (path, u)
}

// MARK: - dictation

func encodeJSArg(_ obj: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var json = String(data: data, encoding: .utf8) else { return nil }
    json = json.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
               .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return json
}

func readStudioLanguageSetting() -> String? {
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("settings.json")),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let lang = obj["language"] as? String else { return nil }
    return lang
}

func resolveDictationLocale(_ hint: String?) -> Locale {
    let raw = (hint ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !raw.isEmpty && raw.lowercased() != "auto" {
        if raw.lowercased() == "tr" { return Locale(identifier: "tr-TR") }
        if raw.lowercased() == "en" { return Locale(identifier: "en-US") }
        return Locale(identifier: raw)
    }
    if let setting = readStudioLanguageSetting()?.lowercased() {
        if setting == "tr" { return Locale(identifier: "tr-TR") }
        if setting == "en" { return Locale(identifier: "en-US") }
    }
    if let first = Locale.preferredLanguages.first, !first.isEmpty {
        if first.lowercased().hasPrefix("tr") { return Locale(identifier: "tr-TR") }
        return Locale(identifier: first)
    }
    return Locale.current
}

final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

final class DictationController {
    weak var web: WKWebView?
    private var isActive = false
    private var stopping = false
    private var finalized = false
    private var sessionID: UInt64 = 0
    private var latestText = ""
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var stopTimer: DispatchWorkItem?

    private func emit(_ payload: [String: Any]) {
        guard let json = encodeJSArg(payload) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.web?.evaluateJavaScript("window.__twDictation && window.__twDictation(\(json))", completionHandler: nil)
        }
    }

    func start(langHint: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.isActive && !self.stopping { return }
            if self.isActive { self.teardown(notifyStopped: false) }
            self.sessionID &+= 1
            let sid = self.sessionID
            self.isActive = true
            self.stopping = false
            self.finalized = false
            self.latestText = ""
            let locale = resolveDictationLocale(langHint)
            self.ensurePermissionsAndBegin(locale: locale, sid: sid)
        }
    }

    func stop() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.isActive else { return }
            if self.recognitionTask == nil {
                self.teardown(notifyStopped: true)
                return
            }
            if self.stopping {
                if !self.finalized && !self.latestText.isEmpty {
                    self.finalized = true
                    self.emit(["type": "final", "text": self.latestText])
                }
                self.teardown(notifyStopped: true)
                return
            }
            self.stopping = true
            self.stopAudioEngine()
            self.recognitionRequest?.endAudio()
            let sid = self.sessionID
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.sessionID == sid, self.isActive else { return }
                if !self.finalized && !self.latestText.isEmpty {
                    self.finalized = true
                    self.emit(["type": "final", "text": self.latestText])
                }
                self.teardown(notifyStopped: true)
            }
            self.stopTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
        }
    }

    func cancel() {
        DispatchQueue.main.async { [weak self] in
            self?.teardown(notifyStopped: false)
        }
    }

    private func failDictation(code: String, message: String) {
        emit(["type": "error", "code": code, "message": message])
        teardown(notifyStopped: true)
    }

    private func ensurePermissionsAndBegin(locale: Locale, sid: UInt64) {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        switch speechStatus {
        case .authorized:
            checkMicPermissionAndBegin(locale: locale, sid: sid)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self = self, self.sessionID == sid, self.isActive, !self.stopping else { return }
                    if status == .authorized {
                        self.checkMicPermissionAndBegin(locale: locale, sid: sid)
                    } else {
                        self.failDictation(
                            code: "speech_denied",
                            message: "Speech recognition permission was denied. Allow it in System Settings > Privacy & Security > Speech Recognition."
                        )
                    }
                }
            }
        case .denied, .restricted:
            failDictation(
                code: "speech_denied",
                message: "Speech recognition permission was denied. Allow it in System Settings > Privacy & Security > Speech Recognition."
            )
        @unknown default:
            failDictation(code: "unavailable", message: "Speech recognition permission is unavailable.")
        }
    }

    private func checkMicPermissionAndBegin(locale: Locale, sid: UInt64) {
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized:
            beginRecognition(locale: locale, sid: sid)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self = self, self.sessionID == sid, self.isActive, !self.stopping else { return }
                    if granted {
                        self.beginRecognition(locale: locale, sid: sid)
                    } else {
                        self.failDictation(
                            code: "mic_denied",
                            message: "Microphone access was denied. Allow it in System Settings > Privacy & Security > Microphone."
                        )
                    }
                }
            }
        case .denied, .restricted:
            failDictation(
                code: "mic_denied",
                message: "Microphone access was denied. Allow it in System Settings > Privacy & Security > Microphone."
            )
        @unknown default:
            failDictation(code: "unavailable", message: "Microphone access is unavailable.")
        }
    }

    private func beginRecognition(locale: Locale, sid: UInt64) {
        guard self.sessionID == sid, self.isActive, !self.stopping else { return }
        let rec = SFSpeechRecognizer(locale: locale)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
            ?? SFSpeechRecognizer()
        guard let rec = rec else {
            failDictation(code: "unavailable", message: "Speech recognition is not available for this language.")
            return
        }
        if !rec.isAvailable && !rec.supportsOnDeviceRecognition {
            failDictation(code: "unavailable", message: "Speech recognition is currently unavailable.")
            return
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            failDictation(code: "unavailable", message: "No audio input device is available.")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            failDictation(code: "failed", message: "Could not start microphone: \(error.localizedDescription)")
            return
        }

        self.recognizer = rec
        self.audioEngine = engine
        self.recognitionRequest = request
        emit([
            "type": "started",
            "onDevice": request.requiresOnDeviceRecognition,
            "locale": rec.locale.identifier,
        ])

        self.recognitionTask = rec.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.sessionID == sid, self.isActive else { return }
                if let result = result {
                    let text = result.bestTranscription.formattedString
                    self.latestText = text
                    if result.isFinal {
                        self.finalized = true
                        self.emit(["type": "final", "text": text])
                        self.teardown(notifyStopped: true)
                        return
                    } else if !self.stopping {
                        self.emit(["type": "partial", "text": text])
                    }
                }
                if let error = error {
                    let nsErr = error as NSError
                    let ignorable = self.finalized || self.stopping || nsErr.code == 216 || nsErr.code == 301 || nsErr.code == 1110
                    if !ignorable {
                        self.emit(["type": "error", "code": "failed", "message": error.localizedDescription])
                    } else if !self.finalized && !self.latestText.isEmpty {
                        self.finalized = true
                        self.emit(["type": "final", "text": self.latestText])
                    }
                    self.teardown(notifyStopped: true)
                }
            }
        }
    }

    private func stopAudioEngine() {
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
    }

    private func teardown(notifyStopped: Bool) {
        sessionID &+= 1
        stopTimer?.cancel()
        stopTimer = nil
        stopAudioEngine()
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        recognizer = nil
        let wasActive = isActive
        isActive = false
        stopping = false
        latestText = ""
        if notifyStopped && wasActive {
            emit(["type": "stopped"])
        }
    }
}

// MARK: - welcome window

func resolveWelcomeLanguage() -> String {
    if let setting = readStudioLanguageSetting()?.lowercased() {
        if setting == "tr" { return "tr" }
        if setting == "en" { return "en" }
    }
    if let first = Locale.preferredLanguages.first?.lowercased(), first.hasPrefix("tr") {
        return "tr"
    }
    return "en"
}

func defaultNewProjectParent() -> String {
    let projects = homeDirURL.appendingPathComponent("Projects", isDirectory: true).path
    if isExistingDirectory(projects) { return projects }
    return homeDirURL.path
}

func appIconDataURL() -> String? {
    guard let icon = NSApp?.applicationIconImage,
          let tiff = icon.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
}

func runGitInit(at path: String) -> (ok: Bool, error: String?) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = ["git", "init"]
    p.currentDirectoryURL = URL(fileURLWithPath: path, isDirectory: true)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    let errPipe = Pipe()
    p.standardOutput = Pipe()
    p.standardError = errPipe
    do {
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus == 0 { return (true, nil) }
        let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (false, msg?.isEmpty == false ? msg : "exit \(p.terminationStatus)")
    } catch {
        return (false, error.localizedDescription)
    }
}

final class WelcomeWebView: WKWebView {
    var onDragState: ((Bool) -> Void)?
    var onDropFolder: ((String) -> Void)?

    override init(frame: NSRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func firstFolderURL(from info: NSDraggingInfo) -> URL? {
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL] else {
            return nil
        }
        return urls.first { isExistingDirectory($0.path) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if firstFolderURL(from: sender) != nil {
            onDragState?(true)
            return .copy
        }
        return []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        firstFolderURL(from: sender) != nil ? .copy : []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragState?(false)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        firstFolderURL(from: sender) != nil
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragState?(false)
        guard let url = firstFolderURL(from: sender) else { return false }
        onDropFolder?(url.path)
        return true
    }
}

final class WelcomeWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    let window: NSWindow
    let web: WelcomeWebView
    let scriptHandler = WeakScriptHandler()
    var onOpenProject: ((String) -> Void)?
    var onClose: (() -> Void)?
    private var lastParent = defaultNewProjectParent()

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.userContentController.add(scriptHandler, name: "twWelcome")
        web = WelcomeWebView(frame: .zero, configuration: cfg)
        if #available(macOS 13.3, *), ProcessInfo.processInfo.environment["TOKENWISE_DEBUG"] == "1" {
            web.isInspectable = true
        }
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        scriptHandler.target = self
        window.title = "tokenwise studio"
        window.contentMinSize = NSSize(width: 540, height: 420)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0.039, green: 0.039, blue: 0.047, alpha: 1)
                : NSColor(red: 0.98, green: 0.98, blue: 0.98, alpha: 1)
        }
        window.center()

        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.onDragState = { [weak self] active in
            self?.evalJS("window.__setDragOver && window.__setDragOver(\(active ? "true" : "false"))")
        }
        web.onDropFolder = { [weak self] path in
            self?.openValidFolder(path)
        }

        let content = NSView()
        content.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.contentView = content
        reloadContent()
    }

    func show() {
        refreshData()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        window.close()
    }

    func refreshData() {
        guard let json = encodeJSArg(buildPayload()) else { return }
        evalJS("window.__updateWelcome && window.__updateWelcome(\(json))")
    }

    private func reloadContent() {
        let html = buildHTML(payload: buildPayload())
        web.loadHTMLString(html, baseURL: nil)
    }

    private func evalJS(_ script: String) {
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func buildPayload() -> [String: Any] {
        let st = readAppState()
        let entries = readRecentEntries(appState: st).map { e -> [String: Any] in
            var obj: [String: Any] = [
                "path": e.path,
                "name": e.name,
                "shortPath": e.shortPath,
                "isGit": e.isGit,
            ]
            if let ts = e.lastOpened { obj["lastOpened"] = ts }
            return obj
        }
        var payload: [String: Any] = [
            "lang": resolveWelcomeLanguage(),
            "recents": entries,
            "defaultParent": lastParent,
            "defaultParentShort": shortenHomePath(lastParent),
        ]
        if let icon = appIconDataURL() { payload["icon"] = icon }
        return payload
    }

    private func openValidFolder(_ rawPath: String) {
        let std = (rawPath as NSString).standardizingPath
        guard isExistingDirectory(std) else { return }
        onOpenProject?(std)
    }

    private func chooseExistingFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        let isTr = resolveWelcomeLanguage() == "tr"
        p.prompt = isTr ? "Projeyi Aç" : "Open Project"
        p.message = isTr ? "tokenwise studio için bir proje klasörü seç" : "Choose a project folder for tokenwise studio"
        p.beginSheetModal(for: window) { [weak self] r in
            if r == .OK, let u = p.url {
                self?.openValidFolder(u.path)
            }
        }
    }

    private func chooseParentFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.canCreateDirectories = true
        if isExistingDirectory(lastParent) {
            p.directoryURL = URL(fileURLWithPath: lastParent, isDirectory: true)
        }
        let isTr = resolveWelcomeLanguage() == "tr"
        p.prompt = isTr ? "Seç" : "Choose"
        p.message = isTr ? "Yeni proje klasörü için konum seç" : "Choose a parent location for the new project folder"
        p.beginSheetModal(for: window) { [weak self] r in
            guard let self = self, r == .OK, let u = p.url else { return }
            let std = (u.path as NSString).standardizingPath
            self.lastParent = std
            if let arg = encodeJSArg(["path": std, "shortPath": shortenHomePath(std)]) {
                self.evalJS("window.__setNewProjectParent && window.__setNewProjectParent(\(arg))")
            }
        }
    }

    private func createProjectFolder(parent rawParent: String, name rawName: String, gitInit: Bool) {
        let isTr = resolveWelcomeLanguage() == "tr"
        func sendError(_ msg: String) {
            if let arg = encodeJSArg(["message": msg]) {
                evalJS("window.__newProjectError && window.__newProjectError(\(arg))")
            }
        }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            sendError(isTr ? "Bir klasör adı gir." : "Enter a folder name.")
            return
        }
        if name.contains("/") || name.contains("\0") || name == "." || name == ".." {
            sendError(isTr ? "Geçerli bir klasör adı gir (eğik çizgi içeremez)." : "Enter a valid folder name (slashes are not allowed).")
            return
        }
        let parent = (rawParent as NSString).standardizingPath
        guard isExistingDirectory(parent) else {
            sendError(isTr ? "Seçilen konum bulunamadı." : "Selected location does not exist.")
            return
        }
        let target = (parent as NSString).appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: target) {
            sendError(isTr ? "Bu konumda aynı adda bir klasör veya dosya zaten var." : "A folder or file with that name already exists there.")
            return
        }
        do {
            try FileManager.default.createDirectory(atPath: target, withIntermediateDirectories: false, attributes: nil)
        } catch {
            sendError((isTr ? "Klasör oluşturulamadı: " : "Could not create folder: ") + error.localizedDescription)
            return
        }
        if gitInit {
            let res = runGitInit(at: target)
            if !res.ok {
                sendError((isTr ? "Klasör oluşturuldu ama git init başarısız oldu: " : "Folder created, but git init failed: ") + (res.error ?? ""))
                return
            }
        }
        lastParent = parent
        openValidFolder(target)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "twWelcome",
              message.frameInfo.isMainFrame,
              message.webView === web,
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "openRecent":
            if let path = body["path"] as? String { openValidFolder(path) }
        case "browse":
            chooseExistingFolder()
        case "chooseNewParent":
            chooseParentFolder()
        case "createProject":
            let parent = (body["parent"] as? String) ?? lastParent
            let name = (body["name"] as? String) ?? ""
            let gitInit = (body["gitInit"] as? Bool) ?? true
            createProjectFolder(parent: parent, name: name, gitInit: gitInit)
        default:
            break
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL, isExistingDirectory(url.path) {
            decisionHandler(.cancel)
            openValidFolder(url.path)
            return
        }
        if url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }

    func windowWillClose(_ n: Notification) {
        onClose?()
    }

    func teardown() {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "twWelcome")
    }

    private func buildHTML(payload: [String: Any]) -> String {
        let initJson = encodeJSArg(payload) ?? "{}"
        return """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>tokenwise studio</title>
        <style>
          :root {
            --bg: #0a0a0c; --s1: #111114; --s2: #17171b; --s3: #1e1e23;
            --line: #232329; --line2: #303038;
            --text: #ededf0; --muted: #9a9aa3; --dim: #63636d;
            --accent: #8b8fff; --accent-hi: #767bf7; --accent-soft: rgba(139,143,255,.14);
            --ok: #5cc98a; --bad: #f07178;
            --shadow: rgba(0,0,0,.45);
            color-scheme: dark;
          }
          @media (prefers-color-scheme: light) {
            :root {
              --bg: #fafafa; --s1: #ffffff; --s2: #f4f4f5; --s3: #ebebee;
              --line: #e5e5ea; --line2: #d6d6dd;
              --text: #18181b; --muted: #55555f; --dim: #8b8b95;
              --accent: #5b5fe0; --accent-hi: #4b4fd1; --accent-soft: rgba(91,95,224,.10);
              --ok: #2f9e62; --bad: #d64550;
              --shadow: rgba(20,20,40,.12);
              color-scheme: light;
            }
          }
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body {
            background: var(--bg); color: var(--text);
            font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
            -webkit-font-smoothing: antialiased;
            user-select: none;
            display: flex; flex-direction: column;
          }
          button { font: inherit; color: inherit; cursor: pointer; }
          .wrap {
            position: relative;
            flex: 1; display: flex; flex-direction: column;
            padding: 28px 30px 24px;
            max-width: 700px; width: 100%; margin: 0 auto;
            min-height: 0;
          }
          .hero { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
          .logo {
            width: 44px; height: 44px; border-radius: 12px;
            background: var(--s2); border: 1px solid var(--line2);
            display: grid; place-items: center; overflow: hidden; flex: none;
          }
          .logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .hero h1 { font-size: 19px; font-weight: 650; letter-spacing: -.3px; margin: 0; }
          .hero h1 span { color: var(--muted); font-weight: 500; }
          .hero p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
          .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
          .btn-primary, .btn-secondary {
            display: flex; align-items: center; justify-content: center; gap: 8px;
            padding: 12px 16px; border-radius: 11px; font-weight: 600; font-size: 13.5px;
            transition: background .14s, border-color .14s, transform .08s;
          }
          .btn-primary {
            background: var(--accent); color: #ffffff; border: 1px solid transparent;
          }
          .btn-primary:hover { background: var(--accent-hi); }
          .btn-secondary {
            background: var(--s2); color: var(--text); border: 1px solid var(--line2);
          }
          .btn-secondary:hover { background: var(--s3); border-color: var(--dim); }
          .btn-primary:active, .btn-secondary:active { transform: translateY(1px); }
          .drop-hint {
            border: 1px dashed var(--line2); border-radius: 10px;
            padding: 8px 12px; text-align: center;
            color: var(--dim); font-size: 12px; margin-bottom: 18px;
            background: var(--s1);
            transition: border-color .15s, background .15s, color .15s;
          }
          .sec-head {
            display: flex; align-items: center; justify-content: space-between;
            font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
            color: var(--dim); margin: 0 2px 8px;
          }
          .recents {
            flex: 1; min-height: 0; overflow-y: auto;
            display: flex; flex-direction: column; gap: 6px;
            padding-right: 2px;
          }
          .recent-item {
            display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
            background: var(--s1); border: 1px solid var(--line); border-radius: 11px;
            padding: 10px 13px;
            transition: background .13s, border-color .13s;
          }
          .recent-item:hover { background: var(--s2); border-color: var(--line2); }
          .recent-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
          .r-icon {
            width: 30px; height: 30px; border-radius: 8px;
            background: var(--s2); border: 1px solid var(--line);
            color: var(--muted); display: grid; place-items: center; flex: none;
          }
          .r-mid { flex: 1; min-width: 0; }
          .r-top { display: flex; align-items: center; gap: 7px; }
          .r-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .badge {
            font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
            flex: none; letter-spacing: .01em;
          }
          .badge.git { background: var(--accent-soft); color: var(--accent); }
          .badge.nongit { background: var(--s3); color: var(--muted); border: 1px solid var(--line2); }
          .r-path {
            font: 12px ui-monospace, "SF Mono", Menlo, monospace;
            color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            margin-top: 2px;
          }
          .r-time { font-size: 12px; color: var(--dim); flex: none; white-space: nowrap; }
          .empty {
            background: var(--s1); border: 1px solid var(--line); border-radius: 12px;
            padding: 26px 18px; text-align: center; color: var(--muted); font-size: 13px;
          }
          .drop-overlay {
            position: fixed; inset: 10px; border-radius: 14px;
            border: 2px dashed var(--accent);
            background: color-mix(in srgb, var(--bg) 82%, var(--accent) 18%);
            display: none; align-items: center; justify-content: center; flex-direction: column; gap: 8px;
            font-size: 15px; font-weight: 600; color: var(--accent);
            z-index: 40; pointer-events: none;
          }
          body.drag-over .drop-overlay { display: flex; }
          .modal-bg {
            position: fixed; inset: 0; background: rgba(0,0,0,.55);
            display: none; align-items: center; justify-content: center; padding: 20px; z-index: 50;
          }
          .modal-bg.open { display: flex; }
          .modal {
            width: 100%; max-width: 440px;
            background: var(--s1); border: 1px solid var(--line2); border-radius: 14px;
            padding: 20px; box-shadow: 0 18px 44px var(--shadow);
          }
          .modal h2 { margin: 0 0 14px; font-size: 16px; font-weight: 650; }
          .field { margin-bottom: 13px; }
          .field label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 5px; }
          .input, .loc-path {
            width: 100%; background: var(--s2); border: 1px solid var(--line2); border-radius: 9px;
            padding: 8px 11px; color: var(--text); font: inherit;
          }
          .input:focus { outline: none; border-color: var(--accent); }
          .loc-row { display: flex; gap: 8px; align-items: center; }
          .loc-path {
            flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font: 12.5px ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted);
          }
          .btn-sm {
            padding: 8px 12px; border-radius: 9px; background: var(--s2); border: 1px solid var(--line2);
            font-size: 12.5px; font-weight: 600; flex: none;
          }
          .btn-sm:hover { background: var(--s3); }
          .preview {
            margin-top: 6px; font: 11.5px ui-monospace, "SF Mono", Menlo, monospace;
            color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); margin: 12px 0 6px; cursor: pointer; }
          .check-row input { accent-color: var(--accent); width: 15px; height: 15px; }
          .err { color: var(--bad); font-size: 12.5px; min-height: 18px; margin-top: 6px; }
          .modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
          .modal-foot .btn-secondary, .modal-foot .btn-primary { padding: 8px 14px; font-size: 13px; border-radius: 9px; }
        </style>
        </head>
        <body>
        <div class="wrap">
          <div class="hero">
            <div class="logo" id="logo"></div>
            <div>
              <h1>tokenwise <span>studio</span></h1>
              <p id="subtitle"></p>
            </div>
          </div>
          <div class="actions">
            <button class="btn-primary" id="open-btn" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span id="open-lbl"></span>
            </button>
            <button class="btn-secondary" id="new-btn" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              <span id="new-lbl"></span>
            </button>
          </div>
          <div class="drop-hint" id="drop-hint"></div>
          <div class="sec-head"><span id="recents-lbl"></span></div>
          <div class="recents" id="recents"></div>
        </div>
        <div class="drop-overlay" id="drop-overlay">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span id="drop-active-lbl"></span>
        </div>
        <div class="modal-bg" id="new-modal">
          <div class="modal" role="dialog" aria-modal="true">
            <h2 id="modal-title"></h2>
            <div class="field">
              <label for="np-name" id="np-name-lbl"></label>
              <input class="input" id="np-name" type="text" autocomplete="off" spellcheck="false">
            </div>
            <div class="field">
              <label id="np-loc-lbl"></label>
              <div class="loc-row">
                <div class="loc-path" id="np-loc"></div>
                <button class="btn-sm" id="np-choose" type="button"></button>
              </div>
              <div class="preview" id="np-preview"></div>
            </div>
            <label class="check-row">
              <input type="checkbox" id="np-git" checked>
              <span id="np-git-lbl"></span>
            </label>
            <div class="err" id="np-err"></div>
            <div class="modal-foot">
              <button class="btn-secondary" id="np-cancel" type="button"></button>
              <button class="btn-primary" id="np-create" type="button"></button>
            </div>
          </div>
        </div>
        <script>
          const STRINGS = {
            en: {
              subtitle: "Pick a project folder to start working with your agent team.",
              openFolder: "Open folder…",
              newFolder: "New project folder…",
              dropHint: "or drop a project folder anywhere here",
              dropActive: "Drop folder to open project",
              recentHeading: "Recent projects",
              emptyRecents: "No recent projects yet. Open an existing folder or create a new one.",
              git: "git",
              nonGit: "no git",
              justNow: "just now",
              minAgo: "{n}m ago",
              hrAgo: "{n}h ago",
              dayAgo: "{n}d ago",
              modalTitle: "New project folder",
              nameLabel: "Folder name",
              namePlaceholder: "my-project",
              locLabel: "Location",
              choose: "Choose…",
              gitInit: "Initialize git repository (git init)",
              cancel: "Cancel",
              createOpen: "Create & Open",
            },
            tr: {
              subtitle: "Ajan ekibinle çalışmaya başlamak için bir proje klasörü seç.",
              openFolder: "Klasör aç…",
              newFolder: "Yeni proje klasörü…",
              dropHint: "veya bir proje klasörünü buraya sürükleyip bırak",
              dropActive: "Projeyi açmak için klasörü bırak",
              recentHeading: "Son projeler",
              emptyRecents: "Henüz son kullanılan proje yok. Var olan bir klasörü aç ya da yeni bir tane oluştur.",
              git: "git",
              nonGit: "git yok",
              justNow: "şimdi",
              minAgo: "{n} dk önce",
              hrAgo: "{n} sa önce",
              dayAgo: "{n} gün önce",
              modalTitle: "Yeni proje klasörü",
              nameLabel: "Klasör adı",
              namePlaceholder: "yeni-projem",
              locLabel: "Konum",
              choose: "Seç…",
              gitInit: "Git deposu başlat (git init)",
              cancel: "Vazgeç",
              createOpen: "Oluştur ve Aç",
            },
          };

          let state = \(initJson);
          let parentPath = state.defaultParent || "";
          let parentShort = state.defaultParentShort || parentPath;

          const $ = (id) => document.getElementById(id);
          const L = () => STRINGS[state.lang === "tr" ? "tr" : "en"];
          const post = (msg) => window.webkit?.messageHandlers?.twWelcome?.postMessage(msg);

          function fmtTime(ts) {
            if (!ts) return "";
            const diff = Math.max(0, Date.now() - ts);
            const mins = Math.floor(diff / 60000);
            const s = L();
            if (mins < 1) return s.justNow;
            if (mins < 60) return s.minAgo.replace("{n}", String(mins));
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return s.hrAgo.replace("{n}", String(hrs));
            const days = Math.floor(hrs / 24);
            if (days < 14) return s.dayAgo.replace("{n}", String(days));
            try {
              return new Date(ts).toLocaleDateString(state.lang === "tr" ? "tr-TR" : "en-US", { month: "short", day: "numeric" });
            } catch {
              return "";
            }
          }

          function renderLogo() {
            const box = $("logo");
            box.textContent = "";
            if (state.icon) {
              const img = document.createElement("img");
              img.src = state.icon;
              img.alt = "";
              box.appendChild(img);
            } else {
              box.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
            }
          }

          function renderTexts() {
            const s = L();
            $("subtitle").textContent = s.subtitle;
            $("open-lbl").textContent = s.openFolder;
            $("new-lbl").textContent = s.newFolder;
            $("drop-hint").textContent = s.dropHint;
            $("drop-active-lbl").textContent = s.dropActive;
            $("recents-lbl").textContent = s.recentHeading;
            $("modal-title").textContent = s.modalTitle;
            $("np-name-lbl").textContent = s.nameLabel;
            $("np-name").placeholder = s.namePlaceholder;
            $("np-loc-lbl").textContent = s.locLabel;
            $("np-choose").textContent = s.choose;
            $("np-git-lbl").textContent = s.gitInit;
            $("np-cancel").textContent = s.cancel;
            $("np-create").textContent = s.createOpen;
          }

          function renderRecents() {
            const s = L();
            const list = $("recents");
            list.textContent = "";
            const items = Array.isArray(state.recents) ? state.recents : [];
            if (!items.length) {
              const empty = document.createElement("div");
              empty.className = "empty";
              empty.textContent = s.emptyRecents;
              list.appendChild(empty);
              return;
            }
            for (const item of items) {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "recent-item";
              btn.title = item.path;
              btn.onclick = () => post({ type: "openRecent", path: item.path });

              const icon = document.createElement("div");
              icon.className = "r-icon";
              icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

              const mid = document.createElement("div");
              mid.className = "r-mid";

              const top = document.createElement("div");
              top.className = "r-top";

              const name = document.createElement("span");
              name.className = "r-name";
              name.textContent = item.name;

              const badge = document.createElement("span");
              badge.className = "badge " + (item.isGit ? "git" : "nongit");
              badge.textContent = item.isGit ? s.git : s.nonGit;

              top.appendChild(name);
              top.appendChild(badge);

              const p = document.createElement("div");
              p.className = "r-path";
              p.textContent = item.shortPath || item.path;

              mid.appendChild(top);
              mid.appendChild(p);

              const time = document.createElement("div");
              time.className = "r-time";
              time.textContent = fmtTime(item.lastOpened);

              btn.appendChild(icon);
              btn.appendChild(mid);
              btn.appendChild(time);
              list.appendChild(btn);
            }
          }

          function updatePreview() {
            $("np-loc").textContent = parentShort || parentPath;
            $("np-loc").title = parentPath;
            const raw = $("np-name").value.trim();
            const sep = parentShort.endsWith("/") ? "" : "/";
            $("np-preview").textContent = raw ? (parentShort + sep + raw) : "";
          }

          function openModal() {
            $("np-err").textContent = "";
            $("np-name").value = "";
            $("np-git").checked = true;
            updatePreview();
            $("new-modal").classList.add("open");
            setTimeout(() => $("np-name").focus(), 20);
          }

          function closeModal() {
            $("new-modal").classList.remove("open");
          }

          $("open-btn").onclick = () => post({ type: "browse" });
          $("new-btn").onclick = openModal;
          $("np-choose").onclick = () => post({ type: "chooseNewParent" });
          $("np-cancel").onclick = closeModal;
          $("new-modal").onclick = (e) => { if (e.target === $("new-modal")) closeModal(); };
          $("np-name").oninput = () => { $("np-err").textContent = ""; updatePreview(); };
          $("np-name").onkeydown = (e) => {
            if (e.key === "Enter") $("np-create").click();
            else if (e.key === "Escape") closeModal();
          };
          $("np-create").onclick = () => {
            post({
              type: "createProject",
              parent: parentPath,
              name: $("np-name").value,
              gitInit: $("np-git").checked,
            });
          };
          document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && $("new-modal").classList.contains("open")) closeModal();
          });
          document.addEventListener("dragover", (e) => e.preventDefault());
          document.addEventListener("drop", (e) => e.preventDefault());

          window.__setDragOver = (on) => document.body.classList.toggle("drag-over", !!on);
          window.__setNewProjectParent = (info) => {
            if (!info || !info.path) return;
            parentPath = info.path;
            parentShort = info.shortPath || info.path;
            $("np-err").textContent = "";
            updatePreview();
          };
          window.__newProjectError = (info) => {
            $("np-err").textContent = info?.message || "Error";
          };
          window.__updateWelcome = (next) => {
            if (!next) return;
            state = next;
            if (!parentPath && state.defaultParent) {
              parentPath = state.defaultParent;
              parentShort = state.defaultParentShort || parentPath;
            }
            renderLogo();
            renderTexts();
            renderRecents();
            updatePreview();
          };

          renderLogo();
          renderTexts();
          renderRecents();
          updatePreview();
        </script>
        </body>
        </html>
        """
    }
}

// MARK: - project window

final class StudioWindow: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var repo: String
    let window: NSWindow
    let web: WKWebView
    let spinner = NSProgressIndicator()
    let label = NSTextField(labelWithString: "Starting…")
    let dictation = DictationController()
    let scriptHandler = WeakScriptHandler()
    var onClose: ((String) -> Void)?
    var onChooseProject: (() -> Void)?
    var onSwitchProject: ((StudioWindow) -> Void)?
    var onProjectSwitched: ((StudioWindow, String) -> Void)?
    var onWindowChanged: (() -> Void)?
    var restarted = false // one automatic restart per page load when the server disappears
    var downloadTargets: [ObjectIdentifier: URL] = [:]
    private var moveSaveWork: DispatchWorkItem?

    private static func isFrameVisible(_ rect: NSRect) -> Bool {
        for screen in NSScreen.screens {
            let inter = rect.intersection(screen.visibleFrame)
            if inter.width >= 100 && inter.height >= 100 { return true }
        }
        return false
    }

    init(repo: String, frame: WindowFrameData? = nil) {
        self.repo = repo
        let name = (repo as NSString).lastPathComponent
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.userContentController.addUserScript(WKUserScript(source: "window.__tokenwiseNative = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(scriptHandler, name: "tw")
        web = WKWebView(frame: .zero, configuration: cfg)
        if #available(macOS 13.3, *), ProcessInfo.processInfo.environment["TOKENWISE_DEBUG"] == "1" { web.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        scriptHandler.target = self
        dictation.web = web
        window.title = "tokenwise studio — \(name)"
        window.contentMinSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false
        window.delegate = self
        let hasAutosaved = window.setFrameAutosaveName("tokenwise-studio:" + repo)
        if let frame = frame, frame.isValid, StudioWindow.isFrameVisible(frame.nsRect) {
            window.setFrame(frame.nsRect, display: false)
        } else if !hasAutosaved {
            window.center()
        }

        let content = NSView()
        web.translatesAutoresizingMaskIntoConstraints = false
        web.isHidden = true
        web.navigationDelegate = self
        web.uiDelegate = self
        spinner.style = .spinning
        spinner.isIndeterminate = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(web)
        content.addSubview(spinner)
        content.addSubview(label)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            spinner.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -10),
            label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
        ])
        window.contentView = content
        spinner.startAnimation(nil)
    }

    func switchTo(repo newRepo: String) {
        self.repo = newRepo
        let name = (newRepo as NSString).lastPathComponent
        window.title = "tokenwise studio — \(name)"
        dictation.cancel()
        restarted = false
        spinner.isHidden = false
        spinner.startAnimation(nil)
        label.isHidden = false
        label.stringValue = "Starting…"
        web.isHidden = true
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load(_ url: URL) {
        if web.url?.absoluteString == url.absoluteString { return }
        web.load(URLRequest(url: url))
    }

    /// The server went away (update, quit): start a fresh one once and load it.
    func restartServer() {
        spinner.isHidden = false
        spinner.startAnimation(nil)
        label.isHidden = false
        label.stringValue = "Restarting…"
        web.isHidden = true
        let repo = self.repo
        DispatchQueue.global().async { [weak self] in
            let u = ensureServer(repo: repo)
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let u = u { self.web.load(URLRequest(url: u)) } else { self.failed("The studio server did not restart within 15 seconds.") }
            }
        }
    }

    func failed(_ why: String) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        label.stringValue = "Could not start"
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "tokenwise studio could not open \((repo as NSString).lastPathComponent)"
        a.informativeText = "\(why)\n\nLog: \(logURL.path)"
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { [weak self] _ in self?.window.close() }
    }

    // navigation: local pages stay in the window, everything else goes to the default browser
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "tokenwise-native", action.sourceFrame.isMainFrame,
           let source = action.sourceFrame.request.url, source.scheme == "http", isLocalHost(source.host) {
            if url.host == "choose-project" {
                decisionHandler(.cancel)
                onChooseProject?()
                return
            }
            if url.host == "switch-project" {
                decisionHandler(.cancel)
                onSwitchProject?(self)
                return
            }
        }
        // <a download> (chat export, blob: URLs) and other explicit downloads: save them instead of navigating.
        if action.shouldPerformDownload { decisionHandler(.download); return }
        let scheme = url.scheme ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { decisionHandler(.allow); return }
        if (scheme == "http" || scheme == "https") && isLocalHost(url.host) && action.targetFrame != nil {
            decisionHandler(.allow); return
        }
        if scheme == "http" || scheme == "https" || scheme == "mailto" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // responses the web view cannot show (or that the server marks as an attachment) become downloads too
    func webView(_ w: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment") { decisionHandler(.download); return }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    // downloads: save to ~/Downloads under a name that does not overwrite anything, then show it in Finder
    static func freeDownloadURL(_ suggested: String) -> URL {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Downloads")
        var name = (suggested as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { name = "download" }
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var url = dir.appendingPathComponent(name)
        var n = 1
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)")
            n += 1
        }
        return url
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let url = StudioWindow.freeDownloadURL(suggestedFilename)
        downloadTargets[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        let a = NSAlert()
        a.messageText = "Download failed"
        a.informativeText = error.localizedDescription
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window, completionHandler: nil)
    }

    func webView(_ w: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ w: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        dictation.cancel()
    }

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        restarted = false
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        label.isHidden = true
        web.isHidden = false
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if !restarted { restarted = true; restartServer(); return }
        failed("The page did not load: \(error.localizedDescription)")
    }

    // JS bridge: window.webkit.messageHandlers.tw.postMessage(...)
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "tw",
              message.frameInfo.isMainFrame,
              isLocalHost(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "dictation" {
            let action = (body["action"] as? String ?? "").lowercased()
            if action == "start" {
                dictation.start(langHint: body["lang"] as? String)
            } else if action == "stop" {
                dictation.stop()
            }
        } else if type == "project" {
            let action = (body["action"] as? String ?? "").lowercased()
            if action == "switched", let newRepo = body["repo"] as? String {
                onProjectSwitched?(self, newRepo)
            } else if action == "switch" {
                onSwitchProject?(self)
            } else if action == "open" {
                onChooseProject?()
            }
        }
    }

    // JS dialogs
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        f.stringValue = defaultText ?? ""
        a.accessoryView = f
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? f.stringValue : nil) }
    }
    func webView(_ w: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    func windowDidMove(_ n: Notification) {
        scheduleWindowChangeSave()
    }

    func windowDidEndLiveResize(_ n: Notification) {
        moveSaveWork?.cancel()
        moveSaveWork = nil
        onWindowChanged?()
    }

    private func scheduleWindowChangeSave() {
        moveSaveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.onWindowChanged?() }
        moveSaveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    func windowWillClose(_ n: Notification) {
        moveSaveWork?.cancel()
        moveSaveWork = nil
        dictation.cancel()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "tw")
        onClose?(repo)
    }
}

// MARK: - app delegate

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
    var windows: [String: StudioWindow] = [:]
    var welcomeWindow: WelcomeWindow?
    var handledLaunch = false // a notification click or open request arrived
    var panelOpen = false
    var isTerminating = false
    let recentMenu = NSMenu(title: "Open Recent")

    func applicationWillFinishLaunching(_ n: Notification) {
        UNUserNotificationCenter.current().delegate = self
        buildMenu()
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        let a = Array(CommandLine.arguments.dropFirst())
        if let u = arg("--open-url", a), let v = validate(repo: arg("--repo", a), url: u) {
            handledLaunch = true
            openProject(repo: v.repo, url: v.url)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
            if !handledLaunch && windows.isEmpty { restoreOrShowWelcome() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty {
            showWelcomeWindow()
            return false
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isTerminating = true
        saveAppStateNow()
        return .terminateNow
    }

    func applicationWillTerminate(_ n: Notification) {
        if !isTerminating {
            isTerminating = true
            saveAppStateNow()
        }
    }

    // tokenwise-studio://open?repo=...&url=...
    func application(_ app: NSApplication, open urls: [URL]) {
        for u in urls where u.scheme == "tokenwise-studio" {
            handledLaunch = true
            let items = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let q = { (n: String) in items.first { $0.name == n }?.value }
            guard u.host == "open", let v = validate(repo: q("repo"), url: q("url")) else { continue }
            openProject(repo: v.repo, url: v.url)
        }
    }

    // MARK: state persistence & restore

    func saveAppStateNow(recordingOpenedRepo openedRepo: String? = nil) {
        var state = readAppState()
        var lastOpened = state.lastOpened ?? [:]
        if let openedRepo = openedRepo {
            let std = (openedRepo as NSString).standardizingPath
            lastOpened[std] = Date().timeIntervalSince1970 * 1000
        }
        // Keep lastOpened bounded
        if lastOpened.count > 40 {
            let keep = Set(lastOpened.sorted { $0.value > $1.value }.prefix(32).map { $0.key })
            lastOpened = lastOpened.filter { keep.contains($0.key) }
        }

        // Preserve back-to-front order so restoring in array order keeps frontmost window on top.
        var orderedRepos: [String] = []
        var byNSWindow: [ObjectIdentifier: StudioWindow] = [:]
        for w in windows.values { byNSWindow[ObjectIdentifier(w.window)] = w }
        for nsw in NSApp.orderedWindows.reversed() {
            if let sw = byNSWindow[ObjectIdentifier(nsw)], !orderedRepos.contains(sw.repo) {
                orderedRepos.append(sw.repo)
            }
        }
        for r in windows.keys.sorted() where !orderedRepos.contains(r) {
            orderedRepos.append(r)
        }

        state.windows = orderedRepos.compactMap { r in
            guard let sw = windows[r] else { return nil }
            let f = sw.window.frame
            let fd = WindowFrameData(x: Double(f.origin.x), y: Double(f.origin.y), width: Double(f.size.width), height: Double(f.size.height))
            return SavedWindowState(repo: r, frame: fd)
        }
        state.lastOpened = lastOpened
        writeAppState(state)
    }

    func restoreOrShowWelcome() {
        let state = readAppState()
        var seen = Set<String>()
        var valid: [SavedWindowState] = []
        for entry in state.windows {
            let std = (entry.repo as NSString).standardizingPath
            guard !seen.contains(std), isExistingDirectory(std) else { continue }
            seen.insert(std)
            valid.append(SavedWindowState(repo: std, frame: entry.frame))
        }
        if valid.isEmpty {
            showWelcomeWindow()
            return
        }
        for item in valid {
            openProject(repo: item.repo, url: nil, frame: item.frame, recordOpened: false)
        }
    }

    // MARK: welcome & opening

    func showWelcomeWindow() {
        if welcomeWindow == nil {
            let ww = WelcomeWindow()
            ww.onOpenProject = { [weak self] repo in
                self?.openProject(repo: repo, url: nil)
            }
            ww.onClose = { [weak self] in
                self?.welcomeWindow?.teardown()
                self?.welcomeWindow = nil
            }
            welcomeWindow = ww
        }
        welcomeWindow?.show()
    }

    func closeWelcomeWindow() {
        welcomeWindow?.close()
    }

    func openProject(repo: String, url: URL?, frame: WindowFrameData? = nil, recordOpened: Bool = true) {
        handledLaunch = true
        let std = (repo as NSString).standardizingPath
        closeWelcomeWindow()
        if recordOpened {
            rememberRecent(std)
        }
        if let w = windows[std] {
            if let url = url { w.load(url) }
            w.show()
            saveAppStateNow(recordingOpenedRepo: recordOpened ? std : nil)
            return
        }
        let w = StudioWindow(repo: std, frame: frame)
        w.onClose = { [weak self] closedRepo in
            guard let self = self else { return }
            self.windows[closedRepo] = nil
            if !self.isTerminating {
                self.saveAppStateNow()
            }
        }
        w.onChooseProject = { [weak self] in self?.showOpenPanel() }
        w.onSwitchProject = { [weak self] win in self?.switchProject(in: win) }
        w.onProjectSwitched = { [weak self] win, newRepo in self?.handleWebProjectSwitch(win, newRepo: newRepo) }
        w.onWindowChanged = { [weak self] in
            guard let self = self, !self.isTerminating else { return }
            self.saveAppStateNow()
        }
        windows[std] = w
        w.show()
        saveAppStateNow(recordingOpenedRepo: recordOpened ? std : nil)
        if let url = url { w.load(url); return }
        DispatchQueue.global().async { [weak w] in
            let u = ensureServer(repo: std)
            DispatchQueue.main.async {
                guard let w = w, w.repo == std else { return }
                if let u = u { w.load(u) } else { w.failed("The studio server did not start within 15 seconds.") }
            }
        }
    }

    func switchProject(in win: StudioWindow) {
        if panelOpen { return }
        panelOpen = true
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        let isTr = resolveWelcomeLanguage() == "tr"
        p.prompt = isTr ? "Değiştir" : "Switch Project"
        p.message = isTr ? "Bu pencerede açılacak proje klasörünü seç" : "Choose a project folder to open in this window"
        p.beginSheetModal(for: win.window) { [weak self, weak win] r in
            guard let self = self else { return }
            self.panelOpen = false
            guard r == .OK, let u = p.url, let win = win else { return }
            let newRepo = (u.path as NSString).standardizingPath
            guard isExistingDirectory(newRepo), newRepo != win.repo else { return }
            if let existing = self.windows[newRepo], existing !== win {
                existing.show()
                win.window.close()
                self.saveAppStateNow(recordingOpenedRepo: newRepo)
                return
            }
            let oldRepo = win.repo
            self.windows.removeValue(forKey: oldRepo)
            self.windows[newRepo] = win
            win.switchTo(repo: newRepo)
            rememberRecent(newRepo)
            self.saveAppStateNow(recordingOpenedRepo: newRepo)
            DispatchQueue.global().async { [weak win] in
                let serverURL = ensureServer(repo: newRepo)
                DispatchQueue.main.async {
                    guard let win = win, win.repo == newRepo else { return }
                    if let serverURL = serverURL { win.load(serverURL) }
                    else { win.failed("The studio server did not start within 15 seconds.") }
                }
            }
        }
    }

    func handleWebProjectSwitch(_ win: StudioWindow, newRepo rawRepo: String) {
        let newRepo = (rawRepo as NSString).standardizingPath
        guard isExistingDirectory(newRepo), newRepo != win.repo else { return }
        if let existing = windows[newRepo], existing !== win {
            existing.window.close()
        }
        windows.removeValue(forKey: win.repo)
        win.repo = newRepo
        win.window.title = "tokenwise studio — \((newRepo as NSString).lastPathComponent)"
        windows[newRepo] = win
        saveAppStateNow(recordingOpenedRepo: newRepo)
    }

    func showOpenPanel() {
        if panelOpen { return }
        panelOpen = true
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        let isTr = resolveWelcomeLanguage() == "tr"
        p.prompt = isTr ? "Projeyi Aç" : "Open Project"
        p.message = isTr ? "tokenwise studio için bir proje seç" : "Choose a project for tokenwise studio"
        let r = p.runModal()
        panelOpen = false
        if r == .OK, let u = p.url { openProject(repo: u.path, url: nil) }
    }

    @objc func openProjectMenu(_ s: Any?) { showOpenPanel() }
    @objc func showWelcomeMenu(_ s: Any?) { showWelcomeWindow() }
    @objc func openRecent(_ s: NSMenuItem) {
        if let p = s.representedObject as? String { openProject(repo: p, url: nil) }
    }
    @objc func reload(_ s: Any?) {
        if let w = windows.values.first(where: { $0.window.isKeyWindow }) { w.web.reload() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        let list = readRecents()
        if list.isEmpty {
            let i = NSMenuItem(title: "No Recent Projects", action: nil, keyEquivalent: ""); i.isEnabled = false
            menu.addItem(i)
        }
        for p in list {
            let i = NSMenuItem(title: (p as NSString).lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "")
            i.representedObject = p; i.target = self; i.toolTip = p
            menu.addItem(i)
        }
    }

    // MARK: menu

    func buildMenu() {
        let name = "tokenwise studio"
        let main = NSMenu()
        func add(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m; return m
        }
        func item(_ m: NSMenu, _ t: String, _ sel: String?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
            let i = NSMenuItem(title: t, action: sel.map { NSSelectorFromString($0) }, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            m.addItem(i)
        }
        let appM = add(name)
        item(appM, "About \(name)", "orderFrontStandardAboutPanel:")
        appM.addItem(.separator())
        item(appM, "Hide \(name)", "hide:", "h")
        item(appM, "Hide Others", "hideOtherApplications:", "h", [.command, .option])
        item(appM, "Show All", "unhideAllApplications:")
        appM.addItem(.separator())
        item(appM, "Quit \(name)", "terminate:", "q")

        let file = add("File")
        item(file, "Open Project…", "openProjectMenu:", "o", target: self)
        let recent = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        recentMenu.delegate = self
        recent.submenu = recentMenu
        file.addItem(recent)
        file.addItem(.separator())
        item(file, "Close Window", "performClose:", "w")

        let edit = add("Edit")
        item(edit, "Undo", "undo:", "z")
        item(edit, "Redo", "redo:", "z", [.command, .shift])
        edit.addItem(.separator())
        item(edit, "Cut", "cut:", "x")
        item(edit, "Copy", "copy:", "c")
        item(edit, "Paste", "paste:", "v")
        item(edit, "Select All", "selectAll:", "a")

        let view = add("View")
        item(view, "Reload", "reload:", "r", target: self)

        let win = add("Window")
        item(win, "Show Welcome Window", "showWelcomeMenu:", "1", [.command, .shift], target: self)
        win.addItem(.separator())
        item(win, "Minimize", "performMiniaturize:", "m")
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    // MARK: notifications

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        handledLaunch = true
        let repo = response.notification.request.content.userInfo["repo"] as? String
        DispatchQueue.main.async { [self] in
            if let r = validate(repo: repo, url: nil) { openProject(repo: r.repo, url: nil) }
            else if windows.isEmpty { showWelcomeWindow() }
            done()
        }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}

// MARK: - --notify

func arg(_ name: String, _ args: [String]) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func postNotification(_ args: [String]) -> Never {
    guard let title = arg("--title", args), let message = arg("--message", args) else { fail("--notify needs --title and --message") }
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var status: UNAuthorizationStatus = .notDetermined
    center.getNotificationSettings { s in status = s.authorizationStatus; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    if status == .notDetermined {
        var granted = false
        var err: Error?
        center.requestAuthorization(options: [.alert, .sound]) { g, e in granted = g; err = e; sem.signal() }
        _ = sem.wait(timeout: .now() + 120) // the user may take a while to answer the prompt
        if !granted { fail("notification permission not granted\(err.map { ": \($0.localizedDescription)" } ?? "")") }
    } else if status == .denied {
        fail("notifications are turned off for tokenwise studio (System Settings > Notifications)")
    }
    let c = UNMutableNotificationContent()
    c.title = title
    c.body = message
    if let s = arg("--subtitle", args), !s.isEmpty { c.subtitle = s }
    c.sound = .default
    if let r = arg("--repo", args), !r.isEmpty { c.userInfo = ["repo": r] }
    var addErr: Error?
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { e in addErr = e; sem.signal() }
    if sem.wait(timeout: .now() + 5) == .timedOut { fail("timed out posting the notification") }
    if let e = addErr { fail("could not post the notification: \(e.localizedDescription)") }
    exit(0)
}

func printStateAndExit() -> Never {
    let appState = readAppState()
    let recents = readRecentEntries(appState: appState)
    let langSetting = readStudioLanguageSetting() ?? "auto"
    let resolvedLang = resolveWelcomeLanguage()
    let windowsList: [[String: Any]] = appState.windows.map { w in
        var obj: [String: Any] = [
            "repo": w.repo,
            "exists": isExistingDirectory((w.repo as NSString).standardizingPath),
        ]
        if let f = w.frame {
            obj["frame"] = ["x": f.x, "y": f.y, "width": f.width, "height": f.height]
        }
        return obj
    }
    let recentsList: [[String: Any]] = recents.map { r in
        var obj: [String: Any] = [
            "path": r.path,
            "name": r.name,
            "shortPath": r.shortPath,
            "isGit": r.isGit,
        ]
        if let ts = r.lastOpened { obj["lastOpened"] = ts }
        return obj
    }
    let payload: [String: Any] = [
        "stateDir": stateDir.path,
        "languageSetting": langSetting,
        "resolvedLanguage": resolvedLang,
        "appState": [
            "windows": windowsList,
            "lastOpened": appState.lastOpened ?? [:],
        ],
        "recents": recentsList,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]),
       let out = String(data: data, encoding: .utf8) {
        print(out)
    } else {
        print("{}")
    }
    exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--print-state") {
    printStateAndExit()
}
recordAppPath()
if args.contains("--notify") {
    NSApplication.shared.setActivationPolicy(.accessory) // windowless, no Dock icon
    postNotification(args)
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
