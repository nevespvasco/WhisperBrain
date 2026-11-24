// Accessibility helper for macOS: reads the page of a browser window (the AX API) and prints it as JSON lines.
//   whisperbrain-ax watch   [--interval-ms N] [--apps REGEX] [--title REGEX] [--max-nodes N]
//   whisperbrain-ax dump    [same options]        one snapshot of every matching window, no limit, then exit
//   whisperbrain-ax windows                       the windows of the browsers (app, title, pid), then exit (never asks for permission)
//   whisperbrain-ax permission                    asks for the Accessibility permission if it is missing, then exits (0: granted)
//
// The same lines as the Linux helper (native/atspi), so one reader (src/meet/a11y.js) serves every system:
//   {"event":"hello","helper":"ax","version":1}
//   {"event":"permission","trusted":true|false}          the Accessibility permission (System Settings → Privacy & Security)
//   {"event":"status","state":"ok"|"no-window"|"no-web-tree"|"no-apps","app":"...","window":"..."}   only when it changes
//   {"event":"snapshot","platform":"darwin","app":"...","window":"...","ms":12,"truncated":false,"nodes":[{"p":-1,"r":"AXWebArea","n":"...","a":{"class":"...","id":"...","subrole":"..."},"s":["focused"]},...]}
// Roles are the native AX ones; src/meet/roles.js puts them in the common vocabulary.
//
// Chromium only builds the page's accessibility tree when something asks for it: setting AXManualAccessibility on the
// application does that (the same switch screen readers use), so the person does not have to start the browser any
// special way. Build: swiftc -O -o whisperbrain-ax whisperbrain-ax.swift -framework ApplicationServices -framework AppKit
import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func out(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text)
}

var interval = 500, maxNodes = 8000
var appsRe = "chrome|brave|edge|vivaldi|opera|chromium|thebrowser"   // Arc is com.thebrowser.Browser
var titleRe = "meet|[a-z]{3}-[a-z]{4}-[a-z]{3}"
var mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "watch"
var i = 2
let args = CommandLine.arguments
while i < args.count {
    switch args[i] {
    case "--interval-ms": i += 1; interval = max(100, Int(args[i]) ?? 500)
    case "--apps": i += 1; appsRe = args[i]
    case "--title": i += 1; titleRe = args[i]
    case "--max-nodes": i += 1; maxNodes = Int(args[i]) ?? 8000
    default: FileHandle.standardError.write("unknown option \(args[i])\n".data(using: .utf8)!); exit(2)
    }
    i += 1
}
guard let appRegex = try? NSRegularExpression(pattern: appsRe, options: [.caseInsensitive]),
      let titleRegex = try? NSRegularExpression(pattern: titleRe, options: [.caseInsensitive]) else {
    FileHandle.standardError.write("bad regular expression\n".data(using: .utf8)!); exit(2)
}
func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, options: [], range: NSRange(s.startIndex..., in: s)) != nil
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String {
    if let s = attr(el, name) as? String { return s }
    return ""
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

// The name a screen reader would speak: title, else description, else (for text) the value.
func nameOf(_ el: AXUIElement) -> String {
    let t = str(el, kAXTitleAttribute as String)
    if !t.isEmpty { return t }
    let d = str(el, kAXDescriptionAttribute as String)
    if !d.isEmpty { return d }
    return str(el, kAXValueAttribute as String)
}

struct Walk { var nodes: [[String: Any]] = []; var truncated = false; let limit: Int }

func walk(_ el: AXUIElement, parent: Int, depth: Int, _ w: inout Walk) {
    if w.nodes.count >= w.limit { w.truncated = true; return }
    if depth > 120 { return }
    let me = w.nodes.count
    var node: [String: Any] = ["p": parent, "r": str(el, kAXRoleAttribute as String), "n": nameOf(el)]
    var a: [String: String] = [:]
    let cls = attr(el, "AXDOMClassList") as? [String]
    if let cls = cls, !cls.isEmpty { a["class"] = cls.joined(separator: " ") }
    let id = str(el, "AXDOMIdentifier"); if !id.isEmpty { a["id"] = id }
    let sub = str(el, kAXSubroleAttribute as String); if !sub.isEmpty { a["subrole"] = sub }
    if !a.isEmpty { node["a"] = a }
    var s: [String] = []
    if (attr(el, kAXFocusedAttribute as String) as? Bool) == true { s.append("focused") }
    if (attr(el, kAXSelectedAttribute as String) as? Bool) == true { s.append("selected") }
    node["s"] = s
    w.nodes.append(node)
    for c in children(el) { if w.truncated { break }; walk(c, parent: me, depth: depth + 1, &w) }
}

// the web content of a window: the first AXWebArea, found breadth-first and not too deep
func findWebArea(_ root: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)], seen = 0
    while !queue.isEmpty {
        let (el, d) = queue.removeFirst()
        if str(el, kAXRoleAttribute as String) == "AXWebArea" { return el }
        seen += 1
        if d < 14 && seen < 400 { for c in children(el) { queue.append((c, d + 1)) } }
    }
    return nil
}

func browsers() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && (matches(appRegex, $0.localizedName ?? "") || matches(appRegex, $0.bundleIdentifier ?? ""))
    }
}
func windows(of app: NSRunningApplication) -> [AXUIElement] {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 0.7)
    // asks the browser to build the page's accessibility tree (what screen readers do)
    AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return (attr(el, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

func trusted(prompt: Bool) -> Bool {
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}

out(["event": "hello", "helper": "ax", "version": 1])

var lastKey = ""
func status(_ state: String, _ app: String, _ window: String) {
    let key = "\(state)|\(app)|\(window)"
    if key != lastKey { lastKey = key; out(["event": "status", "state": state, "app": app, "window": window]) }
}

var isTrusted = trusted(prompt: mode != "windows")
out(["event": "permission", "trusted": isTrusted])
if mode == "permission" { exit(isTrusted ? 0 : 1) }

if mode == "windows" {
    var list: [[String: Any]] = []
    if isTrusted { for app in browsers() { for w in windows(of: app) { list.append(["app": app.localizedName ?? "", "title": str(w, kAXTitleAttribute as String), "pid": Int(app.processIdentifier)]) } } }
    out(["event": "windows", "windows": list])
    exit(0)
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
signal(SIGPIPE, SIG_IGN)

var wait = interval
while true {
    let t0 = Date()
    let now = trusted(prompt: false)
    if now != isTrusted { isTrusted = now; out(["event": "permission", "trusted": now]) }
    if !isTrusted { if mode == "dump" { exit(1) }; Thread.sleep(forTimeInterval: 2); continue }
    let apps = browsers()
    var sawWindow = false
    if apps.isEmpty { status("no-apps", "", "") }
    for app in apps {
        let name = app.localizedName ?? ""
        for win in windows(of: app) {
            let title = str(win, kAXTitleAttribute as String)
            if !matches(titleRegex, title) { continue }
            sawWindow = true
            guard let area = findWebArea(win) else { status("no-web-tree", name, title); continue }
            let w0 = Date()
            var w = Walk(limit: mode == "dump" ? 1_000_000 : maxNodes)
            walk(area, parent: -1, depth: 0, &w)
            status("ok", name, title)
            out(["event": "snapshot", "platform": "darwin", "app": name, "window": title, "ms": Int(Date().timeIntervalSince(w0) * 1000), "truncated": w.truncated, "nodes": w.nodes])
            if mode == "dump" { exit(0) }
        }
    }
    if mode == "dump" { exit(1) }
    if !apps.isEmpty && !sawWindow { status("no-window", "", "") }
    // a slow page is read less often: never more than a third of the time
    let took = Int(Date().timeIntervalSince(t0) * 1000)
    wait = max(interval, took * 3)
    Thread.sleep(forTimeInterval: Double(wait) / 1000)
}
