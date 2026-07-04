// retreat-enforcer.swift
// Reads ~/.config/amber-focus/config.json. When `retreat` is enabled and "now" falls
// inside one of the configured windows (and current date < endDate), kills any
// running app whose bundle ID is not in the allowlist.
//
// Two trigger paths:
//   - NSWorkspace launch observer: instant kill on app launch
//   - 5s ticker: catches apps that were already running when a window started
//
// Build: swiftc retreat-enforcer.swift -o retreat-enforcer -O
// Run as user LaunchAgent (NOT root — NSWorkspace targets the session user).

import Cocoa
import Foundation

let CONFIG_PATH = NSString(string: "~/.config/amber-focus/config.json").expandingTildeInPath
let LOG_PATH = NSString(string: "~/.config/amber-focus/retreat-enforcer.log").expandingTildeInPath

// System-essential bundle IDs that are never killed (would break the OS).
let SYSTEM_ALLOWLIST: Set<String> = [
    "com.apple.finder",
    "com.apple.systempreferences",
    "com.apple.dock",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.systemuiserver",
    "com.apple.WindowManager",
]

struct Window {
    let startMin: Int
    let endMin: Int
    func contains(_ minuteOfDay: Int) -> Bool {
        if startMin <= endMin {
            return minuteOfDay >= startMin && minuteOfDay < endMin
        } else {
            return minuteOfDay >= startMin || minuteOfDay < endMin
        }
    }
}

struct RetreatConfig {
    let enabled: Bool
    let endDate: Date?
    let windows: [Window]
    let allowlist: Set<String>
    let blocklist: Set<String>

    func isActiveNow(_ now: Date = Date()) -> Bool {
        guard enabled else { return false }
        if let end = endDate, now >= end { return false }
        let cal = Calendar.current
        let h = cal.component(.hour, from: now)
        let m = cal.component(.minute, from: now)
        let mod = h * 60 + m
        return windows.contains { $0.contains(mod) }
    }
}

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    FileManager.default.createFile(atPath: LOG_PATH, contents: nil, attributes: nil)
    if let fh = FileHandle(forWritingAtPath: LOG_PATH) {
        fh.seekToEndOfFile()
        if let d = line.data(using: .utf8) { fh.write(d) }
        try? fh.close()
    }
    FileHandle.standardError.write(line.data(using: .utf8) ?? Data())
}

func loadConfig() -> RetreatConfig {
    let empty = RetreatConfig(enabled: false, endDate: nil, windows: [], allowlist: [], blocklist: [])
    guard let data = FileManager.default.contents(atPath: CONFIG_PATH),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let r = json["retreat"] as? [String: Any] else {
        return empty
    }
    let enabled = (r["enabled"] as? Bool) ?? false
    let endDateStr = r["endDate"] as? String ?? ""
    var endDate: Date? = nil
    if !endDateStr.isEmpty {
        let isoFull = ISO8601DateFormatter()
        let isoExt = ISO8601DateFormatter()
        isoExt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        endDate = isoFull.date(from: endDateStr) ?? isoExt.date(from: endDateStr)
        if endDate == nil {
            // Date-only fallback "YYYY-MM-DD"
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd"
            df.timeZone = TimeZone.current
            endDate = df.date(from: endDateStr)
        }
    }
    let windowsRaw = (r["windows"] as? [[String: Any]]) ?? []
    let windows: [Window] = windowsRaw.compactMap { w in
        guard let s = w["start"] as? Int, let e = w["end"] as? Int else { return nil }
        return Window(startMin: s, endMin: e)
    }
    let allowlist = Set((r["allowlist"] as? [String]) ?? [])
    let blocklist = Set((r["blocklist"] as? [String]) ?? [])
    return RetreatConfig(enabled: enabled, endDate: endDate, windows: windows, allowlist: allowlist, blocklist: blocklist)
}

let myPID = ProcessInfo.processInfo.processIdentifier

func killIfDisallowed(_ app: NSRunningApplication, config: RetreatConfig) {
    guard app.processIdentifier != myPID else { return }
    guard app.activationPolicy == .regular else { return }
    guard let bundleID = app.bundleIdentifier else { return }

    let shouldKill: Bool
    if !config.blocklist.isEmpty {
        // Blocklist mode: kill only explicitly listed apps; never touch system apps.
        shouldKill = config.blocklist.contains(bundleID) && !SYSTEM_ALLOWLIST.contains(bundleID)
    } else {
        // Allowlist mode: kill everything not on the allowlist.
        let allowed = config.allowlist.union(SYSTEM_ALLOWLIST)
        shouldKill = !allowed.contains(bundleID)
    }
    guard shouldKill else { return }

    let name = app.localizedName ?? "?"
    if app.terminate() {
        log("terminate \(bundleID) (\(name))")
    } else {
        app.forceTerminate()
        log("forceTerminate \(bundleID) (\(name))")
    }
}

func sweep() {
    let config = loadConfig()
    guard config.isActiveNow() else { return }
    for app in NSWorkspace.shared.runningApplications {
        killIfDisallowed(app, config: config)
    }
}

log("retreat-enforcer starting (pid \(myPID))")

// Launch observer
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didLaunchApplicationNotification,
    object: nil,
    queue: .main
) { note in
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    let config = loadConfig()
    guard config.isActiveNow() else { return }
    killIfDisallowed(app, config: config)
}

// Periodic sweep — every 5s
Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in sweep() }

// Initial sweep
sweep()

RunLoop.main.run()
