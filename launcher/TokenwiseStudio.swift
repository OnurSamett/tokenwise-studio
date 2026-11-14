// tokenwise studio app executable. Compiled by `tokenwise-studio setup` into
// tokenwise studio.app/Contents/MacOS/tokenwise-studio.
//   --notify --title T --message M [--subtitle S] [--repo PATH]   post a notification, then exit
//   --open-url URL --repo PATH     open a window for an already running server
//   tokenwise-studio://open?repo=<path>&url=<url>   same, via the URL scheme (works if already running)
//   (no args)  regular Dock app: notification click -> that repo's window, otherwise the Open Project panel
import AppKit
import WebKit
import UserNotifications

let resources = Bundle.main.resourcePath ?? ""
let stateDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tokenwise-studio")
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

func readRecents() -> [String] {
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("recents.json")),
          let list = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
    return list.filter { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: $0, isDirectory: &d) && d.boolValue }
}

/// Blocking health check (call off the main thread).
func healthy(_ base: URL) -> Bool {
    var req = URLRequest(url: base.appendingPathComponent("api/state"), timeoutInterval: 1)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let h = resp as? HTTPURLResponse, h.statusCode == 200 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 1.5)
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
func ensureServer(repo: String) -> URL? {
    if let u = registeredServer(for: repo) { return u }
    guard spawnServer(repo: repo) else { return nil }
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.4)
        if let u = registeredServer(for: repo) { return u }
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

// MARK: - project window

final class StudioWindow: NSObject, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    let repo: String
    let window: NSWindow
    let web: WKWebView
    let spinner = NSProgressIndicator()
    let label = NSTextField(labelWithString: "Starting…")
    var onClose: ((String) -> Void)?

    init(repo: String) {
        self.repo = repo
        let name = (repo as NSString).lastPathComponent
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        web = WKWebView(frame: .zero, configuration: cfg)
        if #available(macOS 13.3, *), ProcessInfo.processInfo.environment["TOKENWISE_DEBUG"] == "1" { web.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "tokenwise studio — \(name)"
        window.contentMinSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false
        window.delegate = self
        if !window.setFrameAutosaveName("tokenwise-studio:" + repo) { window.center() }

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

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load(_ url: URL) {
        if web.url?.absoluteString == url.absoluteString { return }
        web.load(URLRequest(url: url))
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
        let scheme = url.scheme ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { decisionHandler(.allow); return }
        if (scheme == "http" || scheme == "https") && isLocalHost(url.host) && action.targetFrame != nil {
            decisionHandler(.allow); return
        }
        if scheme == "http" || scheme == "https" || scheme == "mailto" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        label.isHidden = true
        web.isHidden = false
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        failed("The page did not load: \(error.localizedDescription)")
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

    func windowWillClose(_ n: Notification) { onClose?(repo) }
}

// MARK: - app delegate

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
    var windows: [String: StudioWindow] = [:]
    var handledLaunch = false // a notification click or open request arrived
    var panelOpen = false
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
            if !handledLaunch && windows.isEmpty { showOpenPanel() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty { showOpenPanel(); return false }
        return true
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

    // MARK: opening

    func openProject(repo: String, url: URL?) {
        handledLaunch = true
        if let w = windows[repo] {
            if let url = url { w.load(url) }
            w.show(); return
        }
        let w = StudioWindow(repo: repo)
        w.onClose = { [weak self] r in self?.windows[r] = nil }
        windows[repo] = w
        w.show()
        if let url = url { w.load(url); return }
        DispatchQueue.global().async {
            let u = ensureServer(repo: repo)
            DispatchQueue.main.async {
                if let u = u { w.load(u) } else { w.failed("The studio server did not start within 15 seconds.") }
            }
        }
    }

    func showOpenPanel() {
        if panelOpen { return }
        panelOpen = true
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.prompt = "Open Project"
        p.message = "Choose a project for tokenwise studio"
        let r = p.runModal()
        panelOpen = false
        if r == .OK, let u = p.url { openProject(repo: u.path, url: nil) }
        else if windows.isEmpty { NSApp.terminate(nil) }
    }

    @objc func openProjectMenu(_ s: Any?) { showOpenPanel() }
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
            else if windows.isEmpty { showOpenPanel() }
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

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--notify") {
    NSApplication.shared.setActivationPolicy(.accessory) // windowless, no Dock icon
    postNotification(args)
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
