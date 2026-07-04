// amber-focus.swift — native macOS setup + dashboard app for amber-focus
// GUI wrapper around the amber-focus server (localhost:8053). Provides:
// - First-run onboarding wizard (5 screens matching wireframe aesthetic)
// - Menu bar app with popover dashboard (shield status, screen time, activity, browsing)
//
// Does NOT replace the server/daemon — those run as LaunchAgent/LaunchDaemon.
// This app configures via REST API + reads knowledgeC.db + tracks activity via NSEvent.
//
// Compile: swiftc amber-focus.swift -o amber-focus -O -framework IOKit
// Run:     ./amber-focus

import AppKit
import SwiftUI
import Foundation
import SQLite3

// MARK: - Design Tokens

/// Dark theme matching the onboarding wireframe — amber accent on near-black.
struct Design {
    static let bg       = Color(hex: 0x0a0a0a)
    static let surface  = Color(hex: 0x141414)
    static let border   = Color(hex: 0x333333)
    static let text     = Color(hex: 0xe0e0e0)
    static let heading  = Color(hex: 0xf0f0f0)
    static let muted    = Color(hex: 0x999999)
    static let dim      = Color(hex: 0x6a6a6a)
    static let amber    = Color(hex: 0xd4a026)
    static let red      = Color(hex: 0xcc4444)
    static let green    = Color(hex: 0x22aa66)

    // NSColor equivalents for AppKit windows
    static let nsBg     = NSColor(red: 0x0a/255, green: 0x0a/255, blue: 0x0a/255, alpha: 1)

    // Typography — SF Mono throughout
    static let mono      = Font.system(size: 13, weight: .regular, design: .monospaced)
    static let monoSm    = Font.system(size: 12, weight: .regular, design: .monospaced)
    static let monoXs    = Font.system(size: 11, weight: .regular, design: .monospaced)
    static let monoLabel = Font.system(size: 11, weight: .medium, design: .monospaced)
    static let monoMed   = Font.system(size: 13, weight: .medium, design: .monospaced)
    static let monoBold  = Font.system(size: 13, weight: .semibold, design: .monospaced)
    static let monoTitle = Font.system(size: 22, weight: .semibold, design: .monospaced)
    static let monoLarge = Font.system(size: 28, weight: .semibold, design: .monospaced)

    // Popover dimensions
    static let popoverWidth:  CGFloat = 320
    static let popoverHeight: CGFloat = 480
}

// MARK: - Color Extension

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

// MARK: - Shell Helpers

/// Run a command without capturing output (fire and forget).
func shell(_ path: String, _ args: [String]) {
    DispatchQueue.global(qos: .userInitiated).async {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = args
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }
}

/// Run a command and return its stdout synchronously.
func shellOutput(_ path: String, _ args: [String]) -> String {
    let proc = Process()
    let pipe = Pipe()
    proc.executableURL = URL(fileURLWithPath: path)
    proc.arguments = args
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8) ?? ""
}

/// Run a shell command string (via /bin/sh -c) and return stdout+stderr synchronously.
@discardableResult
func shell(_ command: String) -> String {
    let proc = Process()
    let pipe = Pipe()
    proc.executableURL = URL(fileURLWithPath: "/bin/sh")
    proc.arguments = ["-c", command]
    proc.standardOutput = pipe
    proc.standardError = pipe
    try? proc.run()
    proc.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8) ?? ""
}

/// Run a command with sudo via osascript (triggers macOS password prompt).
func shellSudo(_ command: String) -> Bool {
    let escaped = command.replacingOccurrences(of: "\\", with: "\\\\")
                         .replacingOccurrences(of: "\"", with: "\\\"")
    let script = "do shell script \"\(escaped)\" with administrator privileges"
    let proc = Process()
    let pipe = Pipe()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = ["-e", script]
    proc.standardOutput = pipe
    proc.standardError = pipe
    try? proc.run()
    proc.waitUntilExit()
    return proc.terminationStatus == 0
}

// MARK: - Config

/// Paths and constants for the app's local configuration.
struct Config {
    static let configDir = NSHomeDirectory() + "/.config/amber-focus"
    static let configFile = configDir + "/config.json"
    static let profileFile = configDir + "/profile.json"
    static let activityDbPath = configDir + "/activity-app.db"
    static let projectDir = NSHomeDirectory() + "/dev/amber-focus"
    static let apiBase = "http://127.0.0.1:8053"

    /// True if onboarding has been completed (profile.json exists).
    static var onboardingComplete: Bool {
        FileManager.default.fileExists(atPath: profileFile)
    }
}

// MARK: - Block Categories (mirrors store.ts BLOCK_CATEGORIES)

/// Category metadata for the onboarding UI. Domain counts match store.ts.
struct BlockCategory: Identifiable {
    let id: String        // key in BLOCK_CATEGORIES
    let name: String
    let count: String     // "44 domains", "75,000+ domains"
    let examples: String  // preview of what's in the category
    var enabled: Bool = true
}

let defaultCategories: [BlockCategory] = [
    BlockCategory(id: "social", name: "Social media", count: "44 domains",
                  examples: "twitter, x, facebook, instagram, tiktok, reddit, linkedin, discord, threads, bluesky, mastodon, pinterest, hacker news, quora + more"),
    BlockCategory(id: "video", name: "Video & streaming", count: "25 domains",
                  examples: "youtube, netflix, twitch, kick, disney+, hulu, hbo max, prime video, crunchyroll, dailymotion, bilibili, vimeo, rumble + more"),
    BlockCategory(id: "news", name: "News & media", count: "68 domains",
                  examples: "substack, medium, cnn, bbc, nytimes, guardian, spiegel, bild, zeit, faz, orf, nzz, buzzfeed, the verge, ars technica, techcrunch, tmz + more"),
    BlockCategory(id: "shopping", name: "Shopping", count: "28 domains",
                  examples: "amazon, ebay, temu, shein, aliexpress, zalando, etsy, otto, mydealz, kleinanzeigen + more"),
    BlockCategory(id: "sports", name: "Sports", count: "12 domains",
                  examples: "espn, livescore, kicker, flashscore, skysports, bleacherreport + more"),
    BlockCategory(id: "gaming", name: "Gaming", count: "16 domains",
                  examples: "steam, epicgames, ign, kotaku, polygon, chess.com, lichess, roblox + more"),
    BlockCategory(id: "memes", name: "Memes & humor", count: "12 domains",
                  examples: "9gag, imgur, knowyourmeme, fandom, tvtropes + more"),
    BlockCategory(id: "reading", name: "Reading holes", count: "13 domains",
                  examples: "wattpad, royalroad, fanfiction, webtoons, mangadex + more"),
    BlockCategory(id: "dating", name: "Dating", count: "9 domains",
                  examples: "tinder, bumble, hinge, match, okcupid, badoo + more"),
    BlockCategory(id: "gambling", name: "Gambling & betting", count: "19 domains",
                  examples: "bet365, draftkings, pokerstars, betway, tipico + more"),
    BlockCategory(id: "adult", name: "Adult", count: "75,000+ domains",
                  examples: "Comprehensive adult content blocklist. Always on."),
]

// MARK: - Cooldown Sites (high-risk sites for the cooldown screen)

struct CooldownSite: Identifiable {
    let id: String
    let name: String
    let domains: String
    var enabled: Bool = false
    var duration: String = "3h"  // default cooldown
}

let defaultCooldownSites: [CooldownSite] = [
    CooldownSite(id: "twitter", name: "Twitter / X", domains: "twitter.com, x.com", enabled: true, duration: "6h"),
    CooldownSite(id: "youtube", name: "YouTube", domains: "youtube.com, youtu.be", enabled: true, duration: "6h"),
    CooldownSite(id: "reddit", name: "Reddit", domains: "reddit.com"),
    CooldownSite(id: "tiktok", name: "TikTok", domains: "tiktok.com"),
    CooldownSite(id: "instagram", name: "Instagram", domains: "instagram.com"),
]

// MARK: - Onboarding State

/// Tracks an individual step in the activation sequence.
struct SetupStep: Identifiable {
    let id: String
    let label: String
    var status: StepStatus = .pending

    enum StepStatus: Equatable {
        case pending, running, done, failed(String)
    }
}

/// Holds all state collected during the 5-screen onboarding wizard.
class OnboardingState: ObservableObject {
    // Screen 2: Your Why
    @Published var triggers: Set<String> = ["Twitter / X", "YouTube"]
    @Published var customTrigger: String = ""
    @Published var painText: String = ""
    @Published var purposeText: String = ""

    // Screen 3: Categories
    @Published var categories: [BlockCategory] = defaultCategories
    @Published var exceptionDomains: [String] = []
    @Published var exceptionInput: String = ""

    // Screen 4: Cooldowns
    @Published var cooldownSites: [CooldownSite] = defaultCooldownSites

    // Screen 5: Activation — multi-step installer
    @Published var isActivating = false
    @Published var activationComplete = false
    @Published var activationError: String?
    @Published var activationStep: String = ""
    @Published var activationSteps: [SetupStep] = []

    let triggerOptions = ["Twitter / X", "YouTube", "Reddit", "Instagram", "TikTok",
                          "News sites", "Hacker News", "Shopping"]

    var enabledCategoryCount: Int { categories.filter(\.enabled).count }

    var totalDomainCount: String {
        let hasAdult = categories.first(where: { $0.id == "adult" })?.enabled ?? false
        return hasAdult ? "75,800+" : "\(enabledCategoryCount * 20)+"
    }

    var cooldownSummary: String {
        let active = cooldownSites.filter(\.enabled)
        if active.isEmpty { return "None" }
        return active.map { "\($0.name) (\($0.duration))" }.joined(separator: ", ")
    }

    func addException() {
        let domain = exceptionInput.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !domain.isEmpty, !exceptionDomains.contains(domain) else { return }
        exceptionDomains.append(domain)
        exceptionInput = ""
    }

    /// Run the full activation sequence: build, install services, enable pf, configure server, wire MCP.
    func activate() {
        isActivating = true
        activationError = nil

        // Initialize step tracker
        let stepDefs: [(String, String)] = [
            ("build",     "Building server..."),
            ("token",     "Generating MCP token..."),
            ("daemon",    "Installing daemon (admin)..."),
            ("server",    "Installing server service..."),
            ("pf",        "Enabling firewall (admin)..."),
            ("wait",      "Waiting for server..."),
            ("configure", "Configuring shield..."),
            ("mcp",       "Connecting Claude Code..."),
            ("skill",     "Installing Claude skill..."),
        ]
        activationSteps = stepDefs.map { SetupStep(id: $0.0, label: $0.1) }

        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let projectDir = Config.projectDir
            let configDir = Config.configDir

            // Helpers
            func updateStep(_ id: String, _ status: SetupStep.StepStatus) {
                DispatchQueue.main.async {
                    if let idx = self.activationSteps.firstIndex(where: { $0.id == id }) {
                        self.activationSteps[idx].status = status
                    }
                    if case .running = status { self.activationStep = id }
                }
            }
            func fail(_ id: String, _ msg: String) {
                updateStep(id, .failed(msg))
                DispatchQueue.main.async {
                    self.activationError = msg
                    self.isActivating = false
                }
            }

            // --- Resolve node path ---
            let nodePath = shell("which node").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !nodePath.isEmpty else {
                fail("build", "Node.js not found. Install Node.js 18+ first (brew install node).")
                return
            }
            let nodeDir = (nodePath as NSString).deletingLastPathComponent

            // --- 1. Build server ---
            updateStep("build", .running)
            let npmResult = shell("cd '\(projectDir)' && '\(nodePath)' '\(nodeDir)/npm' install --silent 2>&1 && '\(nodeDir)/npx' tsc 2>&1")
            if npmResult.contains("error TS") {
                fail("build", "TypeScript build failed:\n\(npmResult.prefix(200))")
                return
            }
            updateStep("build", .done)

            // --- 2. Generate MCP token ---
            updateStep("token", .running)
            try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
            let tokenFile = configDir + "/mcp-token"
            if !FileManager.default.fileExists(atPath: tokenFile) {
                let token = UUID().uuidString.lowercased()
                try? token.write(toFile: tokenFile, atomically: true, encoding: .utf8)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenFile)
            }
            let mcpToken = (try? String(contentsOfFile: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            updateStep("token", .done)

            // --- 3. Install daemon (requires admin) ---
            updateStep("daemon", .running)

            // Generate daemon plist
            let daemonTemplate = projectDir + "/daemon/com.amberfocus.daemon.plist.template"
            if let template = try? String(contentsOfFile: daemonTemplate, encoding: .utf8) {
                let plist = template
                    .replacingOccurrences(of: "__NODE_PATH__", with: nodePath)
                    .replacingOccurrences(of: "__INSTALL_DIR__", with: projectDir)
                let plistPath = projectDir + "/daemon/com.amberfocus.daemon.plist"
                try? plist.write(toFile: plistPath, atomically: true, encoding: .utf8)

                // Install via admin privilege prompt
                let daemonScript = """
                cp '\(plistPath)' /Library/LaunchDaemons/com.amberfocus.daemon.plist && \
                chown root:wheel /Library/LaunchDaemons/com.amberfocus.daemon.plist && \
                launchctl bootout system /Library/LaunchDaemons/com.amberfocus.daemon.plist 2>/dev/null; \
                launchctl bootstrap system /Library/LaunchDaemons/com.amberfocus.daemon.plist
                """
                let daemonOk = shellSudo(daemonScript)
                if !daemonOk {
                    fail("daemon", "Daemon install cancelled or failed. Admin access is required.")
                    return
                }
            } else {
                fail("daemon", "Daemon plist template not found at \(daemonTemplate)")
                return
            }
            updateStep("daemon", .done)

            // --- 4. Install server LaunchAgent ---
            updateStep("server", .running)
            let home = NSHomeDirectory()
            let serverTemplate = projectDir + "/com.amberfocus.server.plist.template"
            if let template = try? String(contentsOfFile: serverTemplate, encoding: .utf8) {
                let plist = template
                    .replacingOccurrences(of: "__NODE_PATH__", with: nodePath)
                    .replacingOccurrences(of: "__INSTALL_DIR__", with: projectDir)
                    .replacingOccurrences(of: "__HOME_DIR__", with: home)
                    .replacingOccurrences(of: "__NODE_DIR__", with: nodeDir)
                let plistPath = projectDir + "/com.amberfocus.server.plist"
                try? plist.write(toFile: plistPath, atomically: true, encoding: .utf8)

                let agentsDir = home + "/Library/LaunchAgents"
                try? FileManager.default.createDirectory(atPath: agentsDir, withIntermediateDirectories: true)
                let destPath = agentsDir + "/com.amberfocus.server.plist"
                try? FileManager.default.removeItem(atPath: destPath)
                try? FileManager.default.copyItem(atPath: plistPath, toPath: destPath)

                let uid = getuid()
                _ = shell("launchctl bootout gui/\(uid) '\(destPath)' 2>/dev/null; launchctl bootstrap gui/\(uid) '\(destPath)'")
            } else {
                fail("server", "Server plist template not found at \(serverTemplate)")
                return
            }
            updateStep("server", .done)

            // --- 5. Enable pf firewall (requires admin) ---
            updateStep("pf", .running)
            let pfScript = "'\(projectDir)/enable-pf.sh'"
            let pfOk = shellSudo(pfScript)
            if !pfOk {
                // pf is optional — warn but don't block
                updateStep("pf", .failed("Skipped (optional)"))
            } else {
                updateStep("pf", .done)
            }

            // --- 6. Wait for server to be healthy ---
            updateStep("wait", .running)
            var serverUp = false
            for _ in 0..<15 {
                Thread.sleep(forTimeInterval: 1)
                let status = shell("curl -s localhost:8053/status 2>/dev/null")
                if status.contains("running") {
                    serverUp = true
                    break
                }
            }
            if !serverUp {
                fail("wait", "Server didn't start. Check ~/.config/amber-focus/server.log")
                return
            }
            updateStep("wait", .done)

            // --- 7. Configure shield (POST categories, cooldowns, profile) ---
            updateStep("configure", .running)

            let profile: [String: Any] = [
                "triggers": Array(triggers) + (customTrigger.isEmpty ? [] : [customTrigger]),
                "pain": painText,
                "purpose": purposeText,
                "completedAt": ISO8601DateFormatter().string(from: Date()),
            ]
            saveJSON(profile, to: Config.profileFile)
            postJSON("\(Config.apiBase)/api/setup/profile", body: profile)

            let enabledCats = categories.filter(\.enabled).map(\.id)
            postJSON("\(Config.apiBase)/api/setup/categories", body: [
                "categories": enabledCats,
                "exceptions": exceptionDomains,
            ])

            let cooldowns = cooldownSites.filter(\.enabled).map { site -> [String: Any] in
                ["id": site.id, "domains": site.domains, "duration": site.duration]
            }
            postJSON("\(Config.apiBase)/api/setup/cooldowns", body: ["cooldowns": cooldowns])
            postJSON("\(Config.apiBase)/api/setup/activate", body: [:])
            updateStep("configure", .done)

            // --- 8. Wire up Claude Code MCP connection ---
            updateStep("mcp", .running)
            let claudePath = shell("which claude").trimmingCharacters(in: .whitespacesAndNewlines)
            if !claudePath.isEmpty {
                let authHeader = "Authorization: Bearer \(mcpToken)"
                _ = shell("'\(claudePath)' mcp add amber-focus --transport http --scope user --header '\(authHeader)' http://localhost:8053/mcp 2>&1")
                updateStep("mcp", .done)
            } else {
                // Claude CLI not found — user will need to do it manually
                updateStep("mcp", .failed("Claude CLI not found"))
            }

            // --- 9. Install Claude Code skill ---
            updateStep("skill", .running)
            let skillSource = projectDir + "/app/cc-amber-focus.md"
            let skillDir = home + "/.claude/commands"
            let skillDest = skillDir + "/cc-amber-focus.md"
            if FileManager.default.fileExists(atPath: skillSource) {
                try? FileManager.default.createDirectory(atPath: skillDir, withIntermediateDirectories: true)
                try? FileManager.default.removeItem(atPath: skillDest)
                try? FileManager.default.copyItem(atPath: skillSource, toPath: skillDest)
                updateStep("skill", .done)
            } else {
                updateStep("skill", .failed("Skill file not found"))
            }

            // --- Done ---
            DispatchQueue.main.async {
                self.isActivating = false
                self.activationComplete = true
            }
        }
    }
}

/// Save a dictionary as JSON to a file path.
private func saveJSON(_ dict: [String: Any], to path: String) {
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

/// POST JSON to a URL. Returns true on success (2xx).
@discardableResult
private func postJSON(_ urlString: String, body: [String: Any]) -> Bool {
    guard let url = URL(string: urlString),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return false }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = data
    request.timeoutInterval = 5

    let sem = DispatchSemaphore(value: 0)
    var success = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
        if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
            success = true
        }
        sem.signal()
    }.resume()
    sem.wait()
    return success
}

// MARK: - Onboarding Wizard Views

/// Progress bar at the top of the onboarding wizard.
struct OnboardingProgress: View {
    let step: Int
    let total: Int = 4

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color(hex: 0x1a1a1a))
                    Rectangle().fill(Design.amber)
                        .frame(width: geo.size.width * CGFloat(step) / CGFloat(total))
                        .animation(.easeInOut(duration: 0.4), value: step)
                }
            }
            .frame(height: 3)
        }
    }
}

/// Screen 1: Welcome
struct WelcomeScreen: View {
    let onNext: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("""
                ▓▓▓▓▓▓
              ▓▓      ▓▓
             ▓▓  ░░░░  ▓▓
             ▓▓  ░░░░  ▓▓
              ▓▓      ▓▓
                ▓▓▓▓▓▓
            """)
            .font(Design.monoXs)
            .foregroundStyle(Design.amber.opacity(0.6))
            .padding(.bottom, 32)

            Spacer().frame(height: 32)

            VStack(alignment: .leading, spacing: 0) {
                Text("The distracting internet")
                    .font(Design.monoLarge)
                    .foregroundStyle(Design.heading)
                HStack(spacing: 0) {
                    Text("is ")
                        .font(Design.monoLarge)
                        .foregroundStyle(Design.heading)
                    Text("off")
                        .font(Design.monoLarge)
                        .foregroundStyle(Design.amber)
                    Text(".")
                        .font(Design.monoLarge)
                        .foregroundStyle(Design.heading)
                }
            }

            Text("Let's decide what stays on.")
                .font(Design.mono)
                .foregroundStyle(Design.muted)
                .padding(.top, 8)
                .padding(.bottom, 48)

            VStack(alignment: .leading, spacing: 8) {
                Text("Amber blocks everything distracting by default —")
                    .foregroundStyle(Design.dim)
                Text("social media, news, video, forums, all of it.")
                    .foregroundStyle(Design.dim)
                Text("")
                Text("You tell me what's essential, and I'll")
                    .foregroundStyle(Design.dim)
                Text("guard the rest. When you need something")
                    .foregroundStyle(Design.dim)
                Text("back, you ask — and I'll make sure you mean it.")
                    .foregroundStyle(Design.dim)
            }
            .font(Design.mono)

            Spacer()

            Button(action: onNext) {
                Text("Let's go →")
                    .font(Design.monoBold)
                    .foregroundStyle(Color(hex: 0x0a0a0a))
                    .padding(.horizontal, 28)
                    .padding(.vertical, 10)
                    .background(Design.amber)
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)

            Text("Takes about 2 minutes.")
                .font(Design.monoXs)
                .foregroundStyle(Design.dim)
                .padding(.top, 16)
        }
    }
}

/// Screen 2: Your Why
struct YourWhyScreen: View {
    @ObservedObject var state: OnboardingState
    let onNext: () -> Void
    let onBack: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Tell me about it")
                    .font(Design.monoTitle)
                    .foregroundStyle(Design.heading)
                    .padding(.bottom, 8)

                Text("I'll use this to hold you accountable later. Be honest with me.")
                    .font(Design.mono)
                    .foregroundStyle(Design.muted)
                    .padding(.bottom, 48)

                // Triggers
                sectionLabel("What pulls you in?")
                FlowLayout(spacing: 8) {
                    ForEach(state.triggerOptions, id: \.self) { trigger in
                        TagButton(label: trigger, isSelected: state.triggers.contains(trigger)) {
                            if state.triggers.contains(trigger) {
                                state.triggers.remove(trigger)
                            } else {
                                state.triggers.insert(trigger)
                            }
                        }
                    }
                }
                .padding(.bottom, 16)

                TextField("Something else...", text: $state.customTrigger)
                    .textFieldStyle(.plain)
                    .font(Design.mono)
                    .foregroundStyle(Design.text)
                    .padding(12)
                    .background(Design.surface)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                    .cornerRadius(6)
                    .padding(.bottom, 40)

                // Pain
                sectionLabel("What do you lose when it does?")
                TextEditor(text: $state.painText)
                    .font(Design.mono)
                    .foregroundStyle(Design.text)
                    .scrollContentBackground(.hidden)
                    .frame(height: 80)
                    .padding(12)
                    .background(Design.surface)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                    .cornerRadius(6)
                    .padding(.bottom, 40)

                // Purpose
                sectionLabel("What would you rather be doing?")
                TextEditor(text: $state.purposeText)
                    .font(Design.mono)
                    .foregroundStyle(Design.text)
                    .scrollContentBackground(.hidden)
                    .frame(height: 80)
                    .padding(12)
                    .background(Design.surface)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                    .cornerRadius(6)
                    .padding(.bottom, 16)

                Text("Stored locally. I'll use these words to challenge you when you ask for access — not to judge, but to remind you what you told me matters.")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)

                Spacer().frame(height: 48)
                navButtons(onBack: onBack, onNext: onNext)
            }
        }
    }
}

/// Screen 3: Categories
struct CategoriesScreen: View {
    @ObservedObject var state: OnboardingState
    let onNext: () -> Void
    let onBack: () -> Void
    @State private var expandedCategory: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Here's what I block")
                    .font(Design.monoTitle)
                    .foregroundStyle(Design.heading)
                    .padding(.bottom, 8)

                Text("All on by default. Turn off anything you genuinely need for work.")
                    .font(Design.mono)
                    .foregroundStyle(Design.muted)
                    .padding(.bottom, 48)

                sectionLabel("Blocked categories")

                ForEach($state.categories) { $cat in
                    CategoryCard(
                        category: $cat,
                        isExpanded: expandedCategory == cat.id,
                        onToggleExpand: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                expandedCategory = expandedCategory == cat.id ? nil : cat.id
                            }
                        }
                    )
                }

                Spacer().frame(height: 40)

                // Exceptions
                sectionLabel("Need something specific unblocked?")
                HStack(spacing: 8) {
                    TextField("e.g. linkedin.com (for job search)", text: $state.exceptionInput)
                        .textFieldStyle(.plain)
                        .font(Design.mono)
                        .foregroundStyle(Design.text)
                        .padding(12)
                        .background(Design.surface)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                        .cornerRadius(6)
                        .onSubmit { state.addException() }

                    Button(action: { state.addException() }) {
                        Text("+ Allow")
                            .font(Design.monoSm)
                            .foregroundStyle(Design.muted)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color(hex: 0x1a1a1a))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }

                if !state.exceptionDomains.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(state.exceptionDomains, id: \.self) { domain in
                            Text(domain)
                                .font(Design.monoXs)
                                .foregroundStyle(Design.amber)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(Design.amber.opacity(0.08))
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Design.amber.opacity(0.2)))
                                .cornerRadius(4)
                        }
                    }
                    .padding(.top, 12)
                }

                Text("Email, banking, maps, dev tools — all untouched. I only block distractions.")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
                    .padding(.top, 12)

                Spacer().frame(height: 48)
                navButtons(onBack: onBack, onNext: onNext)
            }
        }
    }
}

/// A single category card with toggle and expandable domain list.
struct CategoryCard: View {
    @Binding var category: BlockCategory
    let isExpanded: Bool
    let onToggleExpand: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: onToggleExpand) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(category.name)
                                .font(Design.mono)
                                .foregroundStyle(Color(hex: 0xcccccc))
                            Text("— \(category.count)")
                                .font(Design.monoXs)
                                .foregroundStyle(Design.dim)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Toggle
                Button(action: {
                    // Adult category is always on
                    if category.id != "adult" {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            category.enabled.toggle()
                        }
                    }
                }) {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(category.enabled ? Design.red : Color(hex: 0x2a2a2a))
                        .frame(width: 36, height: 20)
                        .overlay(
                            Circle()
                                .fill(category.enabled ? .white : Color(hex: 0x666666))
                                .frame(width: 16, height: 16)
                                .offset(x: category.enabled ? 8 : -8)
                        )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if isExpanded {
                Text(category.examples)
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(hex: 0x1e1e1e))
        )
        .padding(.bottom, 8)
    }
}

/// Screen 4: Activate — runs the full installation sequence with step-by-step progress.
struct ActivateScreen: View {
    @ObservedObject var state: OnboardingState
    let onBack: () -> Void
    let onComplete: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Here's what I'll do")
                    .font(Design.monoTitle)
                    .foregroundStyle(Design.heading)
                    .padding(.bottom, 8)

                Text("Your shield at a glance.")
                    .font(Design.mono)
                    .foregroundStyle(Design.muted)
                    .padding(.bottom, 32)

                // Summary rows
                summaryRow("Blocked",
                           "\(state.enabledCategoryCount) categories (\(state.totalDomainCount) domains)",
                           color: Design.red)
                summaryRow("Cooldowns", "Twitter/X (6h), YouTube (6h)", color: Design.amber)
                summaryRow("Allowed exceptions",
                           state.exceptionDomains.isEmpty ? "None" : "\(state.exceptionDomains.count) (\(state.exceptionDomains.joined(separator: ", ")))",
                           color: Design.text)

                Spacer().frame(height: 24)

                // Vigilant mode box
                VStack(alignment: .leading, spacing: 8) {
                    Text("◉ Vigilant mode — always on")
                        .font(Design.monoMed)
                        .foregroundStyle(Design.amber)
                    Text("When you get temporary access to something blocked, I watch your screen. Drift off-task and I pull the plug.")
                        .font(Design.mono)
                        .foregroundStyle(Design.muted)
                    Text("Runs on your machine. Screenshots stay local.")
                        .font(Design.mono)
                        .foregroundStyle(Design.dim)
                }
                .padding(20)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.border))
                .cornerRadius(8)

                // --- Installation progress or activate button ---
                if state.activationComplete {
                    completionView
                } else if state.isActivating {
                    progressView
                } else {
                    preActivateView
                }

                if let error = state.activationError, !state.isActivating {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error)
                            .font(Design.monoXs)
                            .foregroundStyle(Design.red)
                        Button(action: { state.activate() }) {
                            Text("Retry")
                                .font(Design.mono)
                                .foregroundStyle(Design.amber)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 8)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.amber))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.top, 16)
                }

                if !state.activationComplete && !state.isActivating {
                    Spacer().frame(height: 32)
                    HStack {
                        Button(action: onBack) {
                            Text("← Back")
                                .font(Design.mono)
                                .foregroundStyle(Design.dim)
                                .padding(.horizontal, 28)
                                .padding(.vertical, 10)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                                .cornerRadius(6)
                        }
                        .buttonStyle(.plain)
                        Spacer()
                    }
                }
            }
        }
    }

    // MARK: - Pre-activate (button to start)

    private var preActivateView: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 40)

            Button(action: { state.activate() }) {
                Text("Activate shield")
                    .font(.system(size: 16, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color(hex: 0x0a0a0a))
                    .padding(.horizontal, 48)
                    .padding(.vertical, 14)
                    .background(Design.amber)
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)

            Text("Builds server, installs services, enables firewall, connects Claude.")
                .font(Design.monoXs)
                .foregroundStyle(Design.dim)

            Text("You'll be prompted for your admin password to install the system daemon and firewall rules.")
                .font(Design.monoXs)
                .foregroundStyle(Design.dim)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Progress view (step-by-step)

    private var progressView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer().frame(height: 32)

            Text("INSTALLING")
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .foregroundStyle(Design.dim)
                .tracking(1)
                .padding(.bottom, 16)

            ForEach(state.activationSteps) { step in
                HStack(spacing: 10) {
                    stepIndicator(step.status)
                    Text(step.label)
                        .font(Design.mono)
                        .foregroundStyle(stepColor(step.status))
                    Spacer()
                    if case .failed(let msg) = step.status {
                        Text(msg.prefix(30))
                            .font(Design.monoXs)
                            .foregroundStyle(Design.red)
                            .lineLimit(1)
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .padding(.leading, 4)
    }

    @ViewBuilder
    private func stepIndicator(_ status: SetupStep.StepStatus) -> some View {
        switch status {
        case .pending:
            Text("○")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Design.dim)
                .frame(width: 16)
        case .running:
            ProgressView()
                .controlSize(.small)
                .frame(width: 16)
        case .done:
            Text("✓")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(Design.green)
                .frame(width: 16)
        case .failed:
            Text("✗")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(Design.red)
                .frame(width: 16)
        }
    }

    private func stepColor(_ status: SetupStep.StepStatus) -> Color {
        switch status {
        case .pending: return Design.dim
        case .running: return Design.text
        case .done: return Design.muted
        case .failed: return Design.red
        }
    }

    // MARK: - Completion view

    private var completionView: some View {
        VStack(spacing: 16) {
            Text("◉ Shield active")
                .font(Design.monoBold)
                .foregroundStyle(Design.green)
                .padding(.top, 40)

            // Show completed steps summary
            VStack(alignment: .leading, spacing: 4) {
                ForEach(state.activationSteps) { step in
                    HStack(spacing: 8) {
                        stepIndicator(step.status)
                        Text(completionLabel(step))
                            .font(Design.monoXs)
                            .foregroundStyle(Design.muted)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Design.surface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.border))
            .cornerRadius(8)

            // Usage instructions
            VStack(alignment: .leading, spacing: 12) {
                Text("HOW TO USE")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(Design.dim)
                    .tracking(1)

                Text("The shield runs 24/7 as a background service. To request temporary access to a blocked site, talk to Claude — it will challenge your intent before granting access.")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.muted)

                CopyableCodeBlock(
                    code: "claude\n> I need reddit for 15 min to check r/rust",
                    color: Design.muted
                )

                Text("Claude will challenge your intent, start a timer, and watch your screen. When time's up, it reblocks automatically.")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)

                // Show manual MCP command if auto-connect failed
                if let mcpStep = state.activationSteps.first(where: { $0.id == "mcp" }),
                   case .failed = mcpStep.status {
                    Text("Connect Claude manually (run once in terminal):")
                        .font(Design.monoXs)
                        .foregroundStyle(Design.muted)
                        .padding(.top, 4)
                    CopyableCodeBlock(
                        code: "claude mcp add amber-focus \\\n  --transport http --scope user \\\n  http://localhost:8053/mcp",
                        color: Design.amber
                    )
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Design.surface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Design.border))
            .cornerRadius(8)

            Spacer().frame(height: 24)

            Button(action: onComplete) {
                Text("Done — start first session →")
                    .font(Design.monoBold)
                    .foregroundStyle(Color(hex: 0x0a0a0a))
                    .padding(.horizontal, 28)
                    .padding(.vertical, 10)
                    .background(Design.amber)
                    .cornerRadius(6)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
    }

    /// Human-readable label for the completion summary.
    private func completionLabel(_ step: SetupStep) -> String {
        switch step.id {
        case "build":     return "Server built"
        case "token":     return "MCP token ready"
        case "daemon":    return "System daemon installed"
        case "server":    return "Server service installed"
        case "pf":        return "Firewall rules active"
        case "wait":      return "Server running on :8053"
        case "configure": return "Shield configured"
        case "mcp":       return "Claude Code connected"
        case "skill":     return "Claude skill installed"
        default:          return step.label
        }
    }

    private func summaryRow(_ label: String, _ value: String, color: Color) -> some View {
        HStack {
            Text(label)
                .font(Design.mono)
                .foregroundStyle(Design.muted)
            Spacer()
            Text(value)
                .font(Design.mono)
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(hex: 0x1a1a1a)).frame(height: 1)
        }
    }
}

/// Reusable section label (uppercase, spaced).
func sectionLabel(_ text: String) -> some View {
    Text(text.uppercased())
        .font(.system(size: 11, weight: .regular, design: .monospaced))
        .foregroundStyle(Design.muted)
        .tracking(1.5)
        .padding(.bottom, 12)
}

/// Reusable tag button (pill shape, toggle selected).
struct TagButton: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Design.mono)
                .foregroundStyle(isSelected ? Design.amber : Color(hex: 0x999999))
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(isSelected ? Design.amber.opacity(0.08) : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 20)
                        .stroke(isSelected ? Design.amber : Design.border)
                )
                .cornerRadius(20)
        }
        .buttonStyle(.plain)
    }
}

/// Reusable back/next button row for onboarding screens.
func navButtons(onBack: @escaping () -> Void, onNext: @escaping () -> Void) -> some View {
    HStack {
        Button(action: onBack) {
            Text("← Back")
                .font(Design.mono)
                .foregroundStyle(Design.dim)
                .padding(.horizontal, 28)
                .padding(.vertical, 10)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Design.border))
                .cornerRadius(6)
        }
        .buttonStyle(.plain)

        Spacer()

        Button(action: onNext) {
            Text("Continue →")
                .font(Design.monoBold)
                .foregroundStyle(Color(hex: 0x0a0a0a))
                .padding(.horizontal, 28)
                .padding(.vertical, 10)
                .background(Design.amber)
                .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
    .padding(.top, 24)
    .overlay(alignment: .top) {
        Rectangle().fill(Color(hex: 0x1a1a1a)).frame(height: 1)
    }
}

/// Simple flow layout for tags — wraps to next line when width exceeded.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = computeLayout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = computeLayout(proposal: proposal, subviews: subviews)
        for (index, offset) in result.offsets.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + offset.x, y: bounds.minY + offset.y),
                                  proposal: .unspecified)
        }
    }

    private func computeLayout(proposal: ProposedViewSize, subviews: Subviews) -> (offsets: [CGPoint], size: CGSize) {
        let maxWidth = proposal.width ?? .infinity
        var offsets: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            offsets.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            maxX = max(maxX, x)
        }

        return (offsets, CGSize(width: maxX, height: y + rowHeight))
    }
}

/// Code block with selectable text and a copy button.
struct CopyableCodeBlock: View {
    let code: String
    var color: Color = Design.amber
    @State private var copied = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Selectable text field (read-only)
            TextEditor(text: .constant(code))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(color)
                .scrollContentBackground(.hidden)
                .scrollDisabled(true)
                .frame(minHeight: CGFloat(code.components(separatedBy: "\n").count) * 16 + 8)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .padding(.trailing, 50) // space for copy button

            // Copy button
            Button(action: {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            }) {
                Text(copied ? "Copied" : "Copy")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(copied ? Design.green : Design.muted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(hex: 0x1a1a1a))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Design.border))
                    .cornerRadius(4)
            }
            .buttonStyle(.plain)
            .padding(8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: 0x0a0a0a))
        .cornerRadius(6)
    }
}

/// The complete onboarding wizard — 4 screens in a single window.
/// Cooldowns are applied as smart defaults (Twitter/X + YouTube at 6h) without a UI step.
struct OnboardingWizard: View {
    @StateObject var state = OnboardingState()
    @State private var currentStep = 1
    let onComplete: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            OnboardingProgress(step: currentStep)

            HStack {
                Spacer()
                Text("\(currentStep) / 4")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
                    .padding(.trailing, 24)
                    .padding(.top, 16)
            }

            Group {
                switch currentStep {
                case 1:
                    WelcomeScreen(onNext: { withAnimation { currentStep = 2 } })
                case 2:
                    YourWhyScreen(state: state,
                                  onNext: { withAnimation { currentStep = 3 } },
                                  onBack: { withAnimation { currentStep = 1 } })
                case 3:
                    CategoriesScreen(state: state,
                                     onNext: { withAnimation { currentStep = 4 } },
                                     onBack: { withAnimation { currentStep = 2 } })
                case 4:
                    ActivateScreen(state: state,
                                   onBack: { withAnimation { currentStep = 3 } },
                                   onComplete: onComplete)
                default:
                    EmptyView()
                }
            }
            .padding(.horizontal, 40)
            .padding(.bottom, 40)
        }
        .frame(width: 720, height: 900)
        .background(Design.bg)
    }
}

// MARK: - Activity Tracker

/// Tracks keyboard, mouse, and cursor activity via NSEvent global monitors.
/// Records aggregate counts — never logs individual keys. Persists daily counters
/// to SQLite so data survives app restarts. Retries keyboard monitor every 2s
/// until Accessibility is granted.
@MainActor
@Observable
class ActivityTracker {
    var totalKeystrokes: Int = 0
    var totalClicks: Int = 0
    var cursorMeters: Double = 0.0
    var hasAccessibility: Bool = false

    /// When the tracker started (or start of day if data was loaded from DB)
    private var sessionStart: Date = Date()
    private var lastCursorPosition: NSPoint?
    private var globalKeyMonitor: Any?
    private var globalMouseMonitor: Any?
    private var globalMoveMonitor: Any?
    private var localKeyMonitor: Any?
    private var saveTimer: Timer?
    private var retryTimer: Timer?

    private var db: OpaquePointer?
    private static let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// ~110 PPI (Retina 2x = 220 px/in, 110 pt/in). 1 pt ~ 0.231mm.
    private static let pointsToMeters: Double = 0.0254 / 110.0

    static func checkAccessibility() -> Bool { AXIsProcessTrusted() }

    func start() {
        openDatabase()
        loadToday()
        hasAccessibility = Self.checkAccessibility()

        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.totalClicks += 1 }
        }

        globalMoveMonitor = NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved) { [weak self] _ in
            Task { @MainActor in self?.trackCursorMovement(to: NSEvent.mouseLocation) }
        }

        tryRegisterKeyboardMonitor()

        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor in
                if event.type == .keyDown { self?.totalKeystrokes += 1 }
                else { self?.totalClicks += 1 }
            }
            return event
        }

        lastCursorPosition = NSEvent.mouseLocation

        retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tryRegisterKeyboardMonitor() }
        }

        saveTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.saveToday() }
        }
    }

    private func tryRegisterKeyboardMonitor() {
        let axNow = Self.checkAccessibility()
        hasAccessibility = axNow
        guard axNow, globalKeyMonitor == nil else { return }

        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            Task { @MainActor in self?.totalKeystrokes += 1 }
        }

        if globalKeyMonitor != nil {
            retryTimer?.invalidate()
            retryTimer = nil
        }
    }

    private func trackCursorMovement(to point: NSPoint) {
        if let last = lastCursorPosition {
            let dx = point.x - last.x
            let dy = point.y - last.y
            cursorMeters += sqrt(dx * dx + dy * dy) * Self.pointsToMeters
        }
        lastCursorPosition = point
    }

    var formattedDistance: String {
        if cursorMeters >= 1000 { return String(format: "%.1fkm", cursorMeters / 1000) }
        return String(format: "%.0fm", cursorMeters)
    }

    /// ~30% overhead (backspace, shortcuts), ~6 keystrokes per word.
    var estimatedWords: Int { max(0, Int(Double(totalKeystrokes) * 0.7 / 6.0)) }

    var formattedWords: String {
        if estimatedWords >= 1000 { return String(format: "%.1fk", Double(estimatedWords) / 1000.0) }
        return "\(estimatedWords)"
    }

    /// Human-readable tracking duration: "today" if started early, otherwise "last Xm/Xh"
    var trackingDuration: String {
        let elapsed = Date().timeIntervalSince(sessionStart)
        let minutes = Int(elapsed / 60)
        let hours = Int(elapsed / 3600)
        if hours >= 12 { return "today" }
        if hours >= 1 { return "last \(hours)h" }
        if minutes >= 1 { return "last \(minutes)m" }
        return "just started"
    }

    func stop() {
        saveToday()
        if let m = globalKeyMonitor { NSEvent.removeMonitor(m); globalKeyMonitor = nil }
        if let m = globalMouseMonitor { NSEvent.removeMonitor(m); globalMouseMonitor = nil }
        if let m = globalMoveMonitor { NSEvent.removeMonitor(m); globalMoveMonitor = nil }
        if let m = localKeyMonitor { NSEvent.removeMonitor(m); localKeyMonitor = nil }
        saveTimer?.invalidate(); retryTimer?.invalidate()
    }

    // MARK: - Persistence

    private func openDatabase() {
        try? FileManager.default.createDirectory(atPath: Config.configDir, withIntermediateDirectories: true)
        guard sqlite3_open(Config.activityDbPath, &db) == SQLITE_OK else { return }
        let schema = """
        CREATE TABLE IF NOT EXISTS activity_daily (
            date TEXT PRIMARY KEY,
            keystrokes INTEGER DEFAULT 0,
            clicks INTEGER DEFAULT 0,
            cursor_meters REAL DEFAULT 0
        );
        """
        sqlite3_exec(db, schema, nil, nil, nil)
    }

    private func todayKey() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    private func loadToday() {
        guard let db = db else { return }
        let sql = "SELECT keystrokes, clicks, cursor_meters FROM activity_daily WHERE date = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        let key = todayKey()
        sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, Self.SQLITE_TRANSIENT)
        if sqlite3_step(stmt) == SQLITE_ROW {
            totalKeystrokes = Int(sqlite3_column_int(stmt, 0))
            totalClicks = Int(sqlite3_column_int(stmt, 1))
            cursorMeters = sqlite3_column_double(stmt, 2)
            // Data existed from earlier today — show "today" as the timeframe
            if totalKeystrokes > 0 || totalClicks > 0 {
                sessionStart = Calendar.current.startOfDay(for: Date())
            }
        }
    }

    func saveToday() {
        guard let db = db else { return }
        let sql = """
        INSERT INTO activity_daily (date, keystrokes, clicks, cursor_meters)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
            keystrokes = excluded.keystrokes,
            clicks = excluded.clicks,
            cursor_meters = excluded.cursor_meters
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        let key = todayKey()
        sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, Self.SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(totalKeystrokes))
        sqlite3_bind_int(stmt, 3, Int32(totalClicks))
        sqlite3_bind_double(stmt, 4, cursorMeters)
        sqlite3_step(stmt)
    }
}

// MARK: - App Name Mapping

/// Bundle ID → friendly name mapping. Global (not actor-isolated) so both
/// AppTracker and ScreenTimeReader can access without crossing actor boundaries.
private let knownAppNames: [String: String] = [
    "com.apple.Safari": "Safari", "com.google.Chrome": "Chrome",
    "com.apple.Terminal": "Terminal", "com.anthropic.claudefordesktop": "Claude",
    "net.whatsapp.WhatsApp": "WhatsApp", "pro.writer.mac": "iA Writer",
    "org.whispersystems.signal-desktop": "Signal", "ru.keepcoder.Telegram": "Telegram",
    "com.apple.finder": "Finder", "com.remarkable.desktop": "reMarkable",
    "com.apple.mail": "Mail", "com.apple.MobileSMS": "Messages",
    "com.apple.Music": "Music", "com.spotify.client": "Spotify",
    "com.apple.Preview": "Preview", "com.apple.Notes": "Notes",
    "com.apple.dt.Xcode": "Xcode", "com.microsoft.VSCode": "VS Code",
    "com.tinyspeck.slackmacgap": "Slack", "com.figma.Desktop": "Figma",
    "us.zoom.xos": "Zoom", "com.linear": "Linear",
    "com.apple.systempreferences": "System Settings",
    "com.culturedcode.ThingsMac": "Things", "company.thebrowser.Browser": "Arc",
    "md.obsidian": "Obsidian", "com.1password.1password": "1Password",
    "com.raycast.macos": "Raycast", "com.mitchellh.ghostty": "Ghostty",
    "com.hnc.Discord": "Discord", "com.notion.id": "Notion",
]

// MARK: - App Tracker

/// Tracks app switches via NSWorkspace notifications. Computes switch rate
/// (30-min rolling window × 2 = per hour) and labels: scattered/switching/focused.
@MainActor
@Observable
class AppTracker {
    var currentAppName: String?
    var switchesToday: Int = 0
    var recentSwitchTimestamps: [Date] = []

    private var currentBundleId: String?
    private var db: OpaquePointer?
    private static let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    func start() {
        openDatabase()
        loadTodayStats()

        if let app = NSWorkspace.shared.frontmostApplication {
            let bundleId = app.bundleIdentifier ?? "unknown"
            currentBundleId = bundleId
            currentAppName = Self.friendlyName(bundleId)
            insertSession(bundleId: bundleId, name: Self.friendlyName(bundleId))
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let bundleId = app.bundleIdentifier ?? "unknown"
            Task { @MainActor in self?.handleAppSwitch(bundleId: bundleId) }
        }
    }

    private func handleAppSwitch(bundleId: String) {
        guard bundleId != currentBundleId else { return }
        closeOpenSessions()

        let now = Date()
        switchesToday += 1
        recentSwitchTimestamps.append(now)
        let cutoff = now.addingTimeInterval(-1800)
        recentSwitchTimestamps.removeAll { $0 < cutoff }

        let name = Self.friendlyName(bundleId)
        currentBundleId = bundleId
        currentAppName = name
        insertSession(bundleId: bundleId, name: name)
    }

    /// Switches in the last 30 minutes, projected to per-hour rate.
    var switchRatePerHour: Int {
        let cutoff = Date().addingTimeInterval(-1800)
        return recentSwitchTimestamps.filter { $0 >= cutoff }.count * 2
    }

    var focusLabel: String {
        let rate = switchRatePerHour
        if rate > 40 { return "scattered" }
        if rate > 20 { return "switching" }
        return "focused"
    }

    /// Today's usage aggregated by app.
    func todayByApp(limit: Int = 5) -> [(name: String, minutes: Double)] {
        guard let db = db else { return [] }
        let startOfDay = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970
        let now = Date().timeIntervalSince1970
        let sql = """
        SELECT app_name, SUM(COALESCE(end_time, ?) - start_time) as total_seconds
        FROM app_sessions WHERE start_time >= ?
        GROUP BY bundle_id ORDER BY total_seconds DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_double(stmt, 1, now)
        sqlite3_bind_double(stmt, 2, startOfDay)
        sqlite3_bind_int(stmt, 3, Int32(limit))

        var results: [(String, Double)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let cName = sqlite3_column_text(stmt, 0) else { continue }
            let seconds = sqlite3_column_double(stmt, 1)
            results.append((String(cString: cName), seconds / 60.0))
        }
        return results
    }

    // MARK: - Database

    private func openDatabase() {
        try? FileManager.default.createDirectory(atPath: Config.configDir, withIntermediateDirectories: true)
        guard sqlite3_open(Config.activityDbPath, &db) == SQLITE_OK else { return }
        let schema = """
        CREATE TABLE IF NOT EXISTS app_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bundle_id TEXT NOT NULL,
            app_name TEXT NOT NULL,
            start_time REAL NOT NULL,
            end_time REAL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_start ON app_sessions(start_time);
        """
        sqlite3_exec(db, schema, nil, nil, nil)
        closeOpenSessions()
    }

    private func insertSession(bundleId: String, name: String) {
        guard let db = db else { return }
        let sql = "INSERT INTO app_sessions (bundle_id, app_name, start_time) VALUES (?, ?, ?)"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, (bundleId as NSString).utf8String, -1, Self.SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, (name as NSString).utf8String, -1, Self.SQLITE_TRANSIENT)
        sqlite3_bind_double(stmt, 3, Date().timeIntervalSince1970)
        sqlite3_step(stmt)
    }

    private func closeOpenSessions() {
        guard let db = db else { return }
        let sql = "UPDATE app_sessions SET end_time = ? WHERE end_time IS NULL"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_double(stmt, 1, Date().timeIntervalSince1970)
        sqlite3_step(stmt)
    }

    private func loadTodayStats() {
        guard let db = db else { return }
        let startOfDay = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970

        let countSQL = "SELECT COUNT(*) FROM app_sessions WHERE start_time >= ?"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, countSQL, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_double(stmt, 1, startOfDay)
            if sqlite3_step(stmt) == SQLITE_ROW {
                switchesToday = max(0, Int(sqlite3_column_int(stmt, 0)) - 1)
            }
            sqlite3_finalize(stmt)
        }

        let cutoff = Date().addingTimeInterval(-1800).timeIntervalSince1970
        let recentSQL = "SELECT start_time FROM app_sessions WHERE start_time >= ? ORDER BY start_time"
        if sqlite3_prepare_v2(db, recentSQL, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_double(stmt, 1, cutoff)
            var timestamps: [Date] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                timestamps.append(Date(timeIntervalSince1970: sqlite3_column_double(stmt, 0)))
            }
            sqlite3_finalize(stmt)
            if timestamps.count > 1 { recentSwitchTimestamps = Array(timestamps.dropFirst()) }
        }
    }

    nonisolated static func friendlyName(_ bundleId: String) -> String {
        if let name = knownAppNames[bundleId] { return name }
        let parts = bundleId.split(separator: ".")
        return String(parts.last ?? Substring(bundleId))
    }
}

// MARK: - Screen Time Reader

/// Reads macOS Screen Time data from knowledgeC.db (SQLite).
/// Requires Full Disk Access to read ~/Library/Application Support/Knowledge/knowledgeC.db.
struct ScreenTimeReader {
    private static let dbPath = NSHomeDirectory() + "/Library/Application Support/Knowledge/knowledgeC.db"

    static func checkAccess() -> Bool {
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil)
        sqlite3_close(db)
        return rc == SQLITE_OK
    }

    /// Today's top apps with total minutes.
    static func todayApps(limit: Int = 5) -> [(name: String, minutes: Double)] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db = db else {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }

        let sql = """
        SELECT ZVALUESTRING, SUM(ZENDDATE - ZSTARTDATE)
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND datetime(ZSTARTDATE + 978307200, 'unixepoch', 'localtime') >= date('now', 'localtime')
          AND (ZENDDATE - ZSTARTDATE) > 0
        GROUP BY ZVALUESTRING ORDER BY 2 DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))

        var results: [(String, Double)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let cStr = sqlite3_column_text(stmt, 0) else { continue }
            let bundleId = String(cString: cStr)
            let seconds = sqlite3_column_double(stmt, 1)
            results.append((AppTracker.friendlyName(bundleId), seconds / 60.0))
        }
        return results
    }

    /// Today's total screen time in minutes.
    static func todayTotal() -> Double {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db = db else {
            sqlite3_close(db)
            return 0
        }
        defer { sqlite3_close(db) }

        let sql = """
        SELECT SUM(ZENDDATE - ZSTARTDATE)
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND datetime(ZSTARTDATE + 978307200, 'unixepoch', 'localtime') >= date('now', 'localtime')
          AND (ZENDDATE - ZSTARTDATE) > 0
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        if sqlite3_step(stmt) == SQLITE_ROW {
            return sqlite3_column_double(stmt, 0) / 60.0
        }
        return 0
    }

    /// Today's top websites with visit counts.
    static func todayWebsites(limit: Int = 5) -> [(domain: String, minutes: Double)] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db = db else {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }

        let sql = """
        SELECT sm.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN,
               SUM(o.ZENDDATE - o.ZSTARTDATE)
        FROM ZOBJECT o
        JOIN ZSTRUCTUREDMETADATA sm ON o.ZSTRUCTUREDMETADATA = sm.Z_PK
        WHERE o.ZSTREAMNAME IN ('/app/usage', '/app/webUsage')
          AND sm.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN IS NOT NULL
          AND datetime(o.ZSTARTDATE + 978307200, 'unixepoch', 'localtime') >= date('now', 'localtime')
          AND (o.ZENDDATE - o.ZSTARTDATE) > 0
        GROUP BY sm.Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN
        ORDER BY 2 DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))

        var results: [(String, Double)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let cStr = sqlite3_column_text(stmt, 0) else { continue }
            let domain = String(cString: cStr)
            let seconds = sqlite3_column_double(stmt, 1)
            results.append((domain, seconds / 60.0))
        }
        return results
    }
}

// MARK: - Shield Client

/// Polls the amber-focus server at localhost:8053 for shield status.
@MainActor
@Observable
class ShieldClient {
    var shieldActive: Bool = false
    var blockedDomains: Int = 0
    var activeAllowances: [(domain: String, expiresAt: Date, minutes: Int)] = []
    var serverReachable: Bool = false

    private var pollTimer: Timer?

    func start() {
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        guard let url = URL(string: "\(Config.apiBase)/status") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { self?.serverReachable = false }
                return
            }
            DispatchQueue.main.async {
                self?.serverReachable = true
                self?.shieldActive = json["shieldActive"] as? Bool ?? false
                self?.blockedDomains = json["blockedDomains"] as? Int ?? 0
            }
        }.resume()

        // Also fetch allowances
        guard let allowUrl = URL(string: "\(Config.apiBase)/api/allowances") else { return }
        var allowReq = URLRequest(url: allowUrl)
        allowReq.timeoutInterval = 3

        URLSession.shared.dataTask(with: allowReq) { [weak self] data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let allowances = json["allowances"] as? [[String: Any]] else { return }

            let parsed = allowances.compactMap { a -> (String, Date, Int)? in
                guard let domain = a["domain"] as? String,
                      let expiresAt = a["expiresAt"] as? Double,
                      let minutes = a["grantedMinutes"] as? Int else { return nil }
                return (domain, Date(timeIntervalSince1970: expiresAt / 1000), minutes)
            }
            DispatchQueue.main.async { self?.activeAllowances = parsed }
        }.resume()
    }

    func stop() { pollTimer?.invalidate() }
}

// MARK: - Dashboard View

/// The menu bar popover dashboard — shield status, screen time, activity, browsing.
struct DashboardView: View {
    let shield: ShieldClient
    let activity: ActivityTracker
    let appTracker: AppTracker

    @State private var screenTimeApps: [(name: String, minutes: Double)] = []
    @State private var screenTimeTotal: Double = 0
    @State private var websites: [(domain: String, minutes: Double)] = []
    @State private var showGrants = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // Shield status
                shieldSection

                Divider().overlay(Design.border)

                // Screen Time
                screenTimeSection

                Divider().overlay(Design.border)

                // Activity
                activitySection

                Divider().overlay(Design.border)

                // Browsing
                browsingSection

                // Active grants (if any)
                if !shield.activeAllowances.isEmpty {
                    Divider().overlay(Design.border)
                    grantsSection
                }

                Divider().overlay(Design.border)

                // Footer
                footerSection
            }
            .padding(16)
        }
        .frame(width: Design.popoverWidth)
        .frame(maxHeight: Design.popoverHeight)
        .background(Design.bg)
        .onAppear { loadScreenTime() }
    }

    // MARK: - Shield Status

    private var shieldSection: some View {
        HStack {
            HStack(spacing: 6) {
                Text(shield.shieldActive ? "◉" : "○")
                    .foregroundStyle(shield.shieldActive ? Design.amber : Design.dim)
                Text(shield.shieldActive ? "Shield active" : "Shield inactive")
                    .font(Design.monoMed)
                    .foregroundStyle(Design.text)
            }
            Spacer()
            if shield.shieldActive {
                Text("\(shield.blockedDomains)")
                    .font(Design.monoSm)
                    .foregroundStyle(Design.muted)
            } else if !shield.serverReachable {
                Text("server offline")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.red)
            }
        }
    }

    // MARK: - Screen Time

    private var screenTimeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Screen Time")
                    .font(Design.monoLabel)
                    .foregroundStyle(Design.text)
                Spacer()
                Text(formatMinutes(screenTimeTotal))
                    .font(Design.monoSm)
                    .foregroundStyle(Design.muted)
            }

            if screenTimeApps.isEmpty {
                Text("Grant Full Disk Access for screen time data")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
            } else {
                ForEach(screenTimeApps, id: \.name) { app in
                    HStack {
                        Text(app.name)
                            .font(Design.monoXs)
                            .foregroundStyle(Design.muted)
                            .lineLimit(1)
                        Spacer()
                        Text(formatMinutes(app.minutes))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Design.dim)
                    }
                }
            }
        }
    }

    // MARK: - Activity

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Activity")
                    .font(Design.monoLabel)
                    .foregroundStyle(Design.text)
                Text(activity.trackingDuration)
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
                Spacer()
                Text(appTracker.focusLabel)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(focusLabelColor)
            }

            HStack(spacing: 12) {
                statBadge(icon: "keyboard", value: activity.totalKeystrokes.formatted())
                statBadge(icon: "cursorarrow.click", value: activity.totalClicks.formatted())
                statBadge(icon: "arrow.up.right", value: activity.formattedDistance)
                statBadge(icon: "text.word.spacing", value: "~\(activity.formattedWords)w")
            }

            HStack(spacing: 4) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 10))
                    .foregroundStyle(Design.dim)
                Text("\(appTracker.switchRatePerHour) switches/hr")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Design.muted)
            }

            if !activity.hasAccessibility {
                Button(action: {
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
                    AXIsProcessTrustedWithOptions(options)
                }) {
                    Text("Grant Accessibility for keystroke tracking →")
                        .font(Design.monoXs)
                        .foregroundStyle(Design.amber)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var focusLabelColor: Color {
        switch appTracker.focusLabel {
        case "scattered": return Design.red
        case "switching": return Design.amber
        default: return Design.green
        }
    }

    // MARK: - Browsing

    private var browsingSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Browsing")
                    .font(Design.monoLabel)
                    .foregroundStyle(Design.text)
                Spacer()
                if !websites.isEmpty {
                    Text("\(websites.count) sites")
                        .font(Design.monoXs)
                        .foregroundStyle(Design.dim)
                }
            }

            if websites.isEmpty {
                Text("No browsing data yet")
                    .font(Design.monoXs)
                    .foregroundStyle(Design.dim)
            } else {
                ForEach(websites, id: \.domain) { site in
                    HStack {
                        Text(site.domain)
                            .font(Design.monoXs)
                            .foregroundStyle(Design.muted)
                            .lineLimit(1)
                        Spacer()
                        Text(formatMinutes(site.minutes))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Design.dim)
                    }
                }
            }
        }
    }

    // MARK: - Active Grants

    private var grantsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("▸ Active grants (\(shield.activeAllowances.count))")
                    .font(Design.monoLabel)
                    .foregroundStyle(Design.text)
                Spacer()
            }

            ForEach(shield.activeAllowances, id: \.domain) { grant in
                HStack {
                    Text(grant.domain)
                        .font(Design.monoXs)
                        .foregroundStyle(Design.green)
                    Spacer()
                    let remaining = Int(grant.expiresAt.timeIntervalSinceNow / 60)
                    Text(remaining > 0 ? "\(remaining)min left" : "expiring")
                        .font(Design.monoXs)
                        .foregroundStyle(remaining > 0 ? Design.muted : Design.red)
                }
            }
        }
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack {
            Spacer()
            Button(action: {
                loadScreenTime()
                shield.refresh()
            }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11))
                    .foregroundStyle(Design.muted)
            }
            .buttonStyle(.plain)

            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .font(Design.monoXs)
                .foregroundStyle(Design.muted)
                .padding(.leading, 8)
        }
    }

    // MARK: - Helpers

    private func statBadge(icon: String, value: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(Design.dim)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Design.muted)
        }
    }

    private func loadScreenTime() {
        DispatchQueue.global(qos: .userInitiated).async {
            let apps = ScreenTimeReader.todayApps()
            let total = ScreenTimeReader.todayTotal()
            let webs = ScreenTimeReader.todayWebsites()
            DispatchQueue.main.async {
                screenTimeApps = apps
                screenTimeTotal = total
                websites = webs
            }
        }
    }

    private func formatMinutes(_ minutes: Double) -> String {
        if minutes < 1 { return "< 1m" }
        let h = Int(minutes) / 60
        let m = Int(minutes) % 60
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        return "\(m)m"
    }
}

// MARK: - Onboarding Window Controller

/// Manages the onboarding wizard window (NSWindow with SwiftUI content).
@MainActor
class OnboardingWindowController {
    private var window: NSWindow?

    func show(onComplete: @escaping () -> Void) {
        // Show in dock during onboarding
        NSApp.setActivationPolicy(.regular)

        let contentView = OnboardingWizard(onComplete: onComplete)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 900),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Amber Focus"
        window.backgroundColor = Design.nsBg
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func dismiss() {
        window?.close()
        window = nil
    }
}

// MARK: - Menu Bar Controller

/// The menu bar status item — amber ◉ when active, ○ when inactive.
/// Click shows/hides the popover dashboard.
@MainActor
class MenuBarController: NSObject {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let shield: ShieldClient
    private let activity: ActivityTracker
    private let appTracker: AppTracker
    private var observation: NSKeyValueObservation?

    init(shield: ShieldClient, activity: ActivityTracker, appTracker: AppTracker) {
        self.shield = shield
        self.activity = activity
        self.appTracker = appTracker
        super.init()
    }

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            // Use SF Symbol for reliable visibility across menu bar themes
            let config = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
            if let img = NSImage(systemSymbolName: "shield", accessibilityDescription: "amber-focus")?.withSymbolConfiguration(config) {
                img.isTemplate = true
                button.image = img
            } else {
                // Fallback text if SF Symbols unavailable
                button.title = "AF"
                button.font = NSFont.systemFont(ofSize: 12, weight: .bold)
            }
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp])
        }

        popover = NSPopover()
        popover.contentSize = NSSize(width: Int(Design.popoverWidth), height: Int(Design.popoverHeight))
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: DashboardView(shield: shield, activity: activity, appTracker: appTracker)
        )

        // Poll to update the menu bar icon based on shield status
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateIcon() }
        }

        NSLog("[amber-focus] Menu bar ready")
    }

    @MainActor
    private func updateIcon() {
        if let button = statusItem?.button {
            let symbolName = shield.shieldActive ? "shield.fill" : "shield"
            let config = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
            if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: "amber-focus")?.withSymbolConfiguration(config) {
                // When active: amber tinted. When inactive: template (adapts to menu bar).
                if shield.shieldActive {
                    img.isTemplate = false
                    let tinted = NSImage(size: img.size, flipped: false) { rect in
                        img.draw(in: rect)
                        NSColor(red: 0xd4/255, green: 0xa0/255, blue: 0x26/255, alpha: 1).set()
                        rect.fill(using: .sourceAtop)
                        return true
                    }
                    button.image = tinted
                } else {
                    img.isTemplate = true
                    button.image = img
                }
            }
        }
    }

    @objc private func statusItemClicked() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            // Refresh data when showing
            shield.refresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }
}

// MARK: - App Delegate

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    let shield = ShieldClient()
    let activity = ActivityTracker()
    let appTracker = AppTracker()
    var menuBar: MenuBarController!
    var onboardingWindow: OnboardingWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("[amber-focus] Starting amber-focus app")

        // Always set up menu bar + trackers immediately so the status item
        // is visible from the start regardless of onboarding state
        menuBar = MenuBarController(shield: shield, activity: activity, appTracker: appTracker)
        menuBar.setup()
        shield.start()
        activity.start()
        appTracker.start()

        if Config.onboardingComplete {
            // Already onboarded — just the menu bar
            NSApp.setActivationPolicy(.accessory)
        } else {
            // Show onboarding wizard on top of menu bar
            onboardingWindow = OnboardingWindowController()
            onboardingWindow?.show(onComplete: { [weak self] in
                // Onboarding done — dismiss window, hide dock icon, launch first CC session
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self?.onboardingWindow?.dismiss()
                    self?.onboardingWindow = nil
                    NSApp.setActivationPolicy(.accessory)
                    self?.launchFirstClaudeSession()
                }
            })
        }

        NSLog("[amber-focus] Menu bar mode active")
    }

    /// Launch the first Claude Code session after onboarding completes.
    /// Opens the user's terminal with the amber-focus CLI, which starts an
    /// interactive CC session showing shield status.
    func launchFirstClaudeSession() {
        let claudePath = shell("which claude").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !claudePath.isEmpty else {
            NSLog("[amber-focus] Claude CLI not found — skipping first session launch")
            return
        }

        let projectDir = Config.projectDir
        let command = "'\(projectDir)/bin/amber-focus'"

        // Detect preferred terminal: check for running apps first, fall back to Terminal.app
        let terminals = ["Ghostty", "iTerm", "Terminal"]
        var targetTerminal = "Terminal"
        for term in terminals {
            let check = shell("pgrep -x '\(term)' 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
            if !check.isEmpty {
                targetTerminal = term
                break
            }
        }

        let script: String
        switch targetTerminal {
        case "Ghostty":
            // Ghostty doesn't support AppleScript well — use open + shell
            script = """
            tell application "Ghostty"
                activate
            end tell
            delay 0.5
            tell application "System Events"
                keystroke "t" using command down
                delay 0.3
                keystroke "\(command)"
                key code 36
            end tell
            """
        case "iTerm":
            script = """
            tell application "iTerm"
                activate
                tell current window
                    create tab with default profile
                    tell current session
                        write text "\(command)"
                    end tell
                end tell
            end tell
            """
        default:
            script = """
            tell application "Terminal"
                activate
                do script "\(command)"
            end tell
            """
        }

        // Run AppleScript asynchronously to avoid blocking the main thread
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.launchPath = "/usr/bin/osascript"
            task.arguments = ["-e", script]
            try? task.run()
            task.waitUntilExit()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        activity.stop()
        shield.stop()
    }
}

// MARK: - Main Entry Point

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
