// tokenwise studio app executable. Compiled by `tokenwise-studio setup` into
// tokenwise studio.app/Contents/MacOS/tokenwise-studio.
//   --notify --title T --message M [--subtitle S] [--repo PATH]   post a notification, then exit
//   (no args)  launched by LaunchServices: handle a notification click, or run the folder picker
import AppKit
import UserNotifications

let resources = Bundle.main.resourcePath ?? ""

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("tokenwise-studio: \(msg)\n".utf8))
    exit(1)
}

// MARK: - opening the studio

func runPicker() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [resources + "/pick.sh"]
    try? p.run() // detached: it outlives us
}

func serverURL(for repo: String) -> URL? {
    let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tokenwise-studio/servers.json")
    guard let data = try? Data(contentsOf: file),
          let map = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let s = map[repo], let base = URL(string: s) else { return nil }
    var req = URLRequest(url: base.appendingPathComponent("api/state"), timeoutInterval: 1)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let h = resp as? HTTPURLResponse, h.statusCode == 200 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 1.5)
    return ok ? base : nil
}

func openStudio(repo: String?) {
    guard let repo = repo, !repo.isEmpty else { runPicker(); return }
    if let url = serverURL(for: repo) { NSWorkspace.shared.open(url); return }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: resources + "/config.json")),
          let cfg = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let node = cfg["node"], let cli = cfg["cli"] else { runPicker(); return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [cli, repo]
    var env = ProcessInfo.processInfo.environment
    let nodeDir = (node as NSString).deletingLastPathComponent
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(nodeDir):" + (env["PATH"] ?? "/usr/bin:/bin")
    p.environment = env
    let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tokenwise-studio/launcher.log")
    try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
    if let h = try? FileHandle(forWritingTo: log) {
        h.seekToEndOfFile()
        p.standardOutput = h
        p.standardError = h
    }
    p.standardInput = FileHandle.nullDevice
    try? p.run() // cli.js opens the browser itself once the server is up
}

// MARK: - app delegate (LaunchServices launch / notification click)

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var gotResponse = false

    func applicationWillFinishLaunching(_ n: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
            if !gotResponse { runPicker(); NSApp.terminate(nil) }
        }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        gotResponse = true
        let repo = response.notification.request.content.userInfo["repo"] as? String
        DispatchQueue.global().async {
            openStudio(repo: repo)
            done()
            DispatchQueue.main.async { NSApp.terminate(nil) }
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
if args.contains("--notify") { postNotification(args) }

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
