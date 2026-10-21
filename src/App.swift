import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var input: Pipe?
    var pending = Data()
    let decodeQueue = DispatchQueue(label: "dual-lens.output")
    var ready = false
    var queued: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "native")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x:0, y:0, width:1240, height:850), styleMask:[.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView], backing:.buffered, defer:false)
        window.title = "Dual Lens"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width:900, height:650)
        window.backgroundColor = NSColor(calibratedRed:0.965, green:0.957, blue:0.937, alpha:1)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("DualLensMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        startBackend()
        if let resource = Bundle.main.resourceURL {
            web.loadFileURL(resource.appendingPathComponent("web/index.html"), allowingReadAccessTo:resource.appendingPathComponent("web"))
        }
    }
    func createMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle:"Dual Lens 종료", action:#selector(NSApplication.terminate(_:)), keyEquivalent:"q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title:"편집"); editItem.submenu = edit
        edit.addItem(withTitle:"실행 취소", action:Selector(("undo:")), keyEquivalent:"z")
        edit.addItem(withTitle:"잘라내기", action:#selector(NSText.cut(_:)), keyEquivalent:"x")
        edit.addItem(withTitle:"복사", action:#selector(NSText.copy(_:)), keyEquivalent:"c")
        edit.addItem(withTitle:"붙여넣기", action:#selector(NSText.paste(_:)), keyEquivalent:"v")
        edit.addItem(withTitle:"모두 선택", action:#selector(NSText.selectAll(_:)), keyEquivalent:"a")
        NSApp.mainMenu = menu
    }
    func executable(_ name:String)->String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dirs = [home + "/.local/bin", home + "/npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        return dirs.map { $0 + "/" + name }.first { FileManager.default.isExecutableFile(atPath:$0) }
    }
    func setupStatus() {
        send(["type":"setupStatus", "runtime":backend?.isRunning == true,
              "nodeInstalled":executable("node") != nil,
              "gpt":executable("codex") != nil, "claude":executable("claude") != nil,
              "python":executable("python3") != nil])
    }
    func shellQuote(_ value:String)->String { "'" + value.replacingOccurrences(of:"'", with:"'\\''") + "'" }
    func openLogin(_ provider:String) {
        guard ["gpt","claude"].contains(provider), let file = executable(provider == "gpt" ? "codex" : "claude") else {
            send(["type":"error","message":"먼저 해당 도구를 설치해 주세요."]); return
        }
        // This launcher delegates authentication to the original CLI in Terminal.
        // It never receives a password, callback, or token.
        do {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Dual Lens/login")
            try FileManager.default.createDirectory(at:folder, withIntermediateDirectories:true, attributes:[.posixPermissions:0o700])
            let path = [home + "/.local/bin",home + "/npm-global/bin","/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"].joined(separator:":")
            let args = provider == "gpt" ? " login" : " auth login"
            let script = "#!/bin/sh\ncd " + shellQuote(folder.path) + " || exit 1\n/usr/bin/env -i HOME=" + shellQuote(home) + " PATH=" + shellQuote(path) + " TERM=xterm-256color LANG=en_US.UTF-8 " + shellQuote(file) + args + "\nresult=$?\nif [ \"$result\" -eq 0 ]; then\n  printf '\\n로그인이 완료되었습니다. Dual Lens에서 연결 확인을 누르세요.\\n'\nelse\n  printf '\\n로그인이 완료되지 않았습니다. 위 메시지를 확인하세요.\\n'\nfi\n"
            let url = folder.appendingPathComponent(provider + "-login.command")
            try script.write(to:url, atomically:true, encoding:.utf8)
            try FileManager.default.setAttributes([.posixPermissions:0o700], ofItemAtPath:url.path)
            NSWorkspace.shared.open(url)
        } catch { send(["type":"error","message":"로그인 화면을 열지 못했습니다: \(error.localizedDescription)"]) }
    }
    func startBackend() {
        if backend?.isRunning == true { return }
        guard let resources = Bundle.main.resourceURL else { return }
        guard let node = executable("node") else {
            send(["type":"error", "message":"Node.js를 찾을 수 없습니다. Node.js 22 이상이 필요합니다."]); return
        }
        let process = Process(); backend = process
        process.executableURL = URL(fileURLWithPath:node)
        process.arguments = [resources.appendingPathComponent("src/backend.mjs").path]
        let stdin = Pipe(); let stdout = Pipe(); let stderr = Pipe(); input = stdin
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.decodeQueue.async { [weak self] in
                guard let self = self else { return }
                self.pending.append(data)
                while let range = self.pending.range(of:Data([10])) {
                    let line = self.pending.subdata(in:0..<range.lowerBound)
                    self.pending.removeSubrange(0..<range.upperBound)
                    if let text = String(data:line, encoding:.utf8) {
                        DispatchQueue.main.async { self.deliver(text) }
                    }
                }
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.send(["type":"error", "message":"연결 프로세스가 종료되었습니다. 앱을 다시 열어 주세요."]) }
        }
        do { try process.run() } catch { send(["type":"error", "message":"앱 연결을 시작하지 못했습니다: \(error.localizedDescription)"]) }
    }
    func send(_ value: [String:Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject:value), let text = String(data:data, encoding:.utf8) else { return }
        deliver(text)
    }
    func deliver(_ text: String) {
        if !ready { queued.append(text); return }
        let base64 = Data(text.utf8).base64EncodedString()
        web.evaluateJavaScript("window.receive(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(base64)'),c=>c.charCodeAt(0)))))", completionHandler:nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String:Any], let action = body["action"] as? String else { return }
        if action == "ready" {
            ready = true
            let events = queued; queued.removeAll()
            for event in events { deliver(event) }
            setupStatus()
            if backend?.isRunning == true { write(["action":"init"]) }; return
        }
        if action == "setupStatus" { setupStatus(); return }
        if action == "retryRuntime" {
            startBackend(); setupStatus()
            if backend?.isRunning == true { write(["action":"init"]) }; return
        }
        if action == "login", let provider = body["provider"] as? String { openLogin(provider); return }
        if action == "setupGuide", let tool = body["tool"] as? String {
            let links = ["node":"https://nodejs.org/en/download", "gpt":"https://developers.openai.com/codex/cli",
                         "claude":"https://code.claude.com/docs/en/quickstart", "python":"https://developer.apple.com/xcode/resources/"]
            if let link = links[tool], let url = URL(string:link) { NSWorkspace.shared.open(url) }; return
        }
        if action == "importFolder" {
            let requestID = body["requestId"] as? String ?? ""
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.allowsMultipleSelection = false; panel.prompt = "폴더 읽기"
            panel.beginSheetModal(for:window) { response in
                guard response == .OK, let url = panel.url else {
                    self.send(["type":"folderCancelled", "requestId":requestID]); return
                }
                self.write(["action":"scan-folder", "path":url.path, "requestId":requestID])
            }; return
        }
        if action == "copy", let text = body["text"] as? String {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType:.string); return
        }
        if action == "export", let text = body["text"] as? String {
            let panel = NSSavePanel(); panel.nameFieldStringValue = "Dual Lens 대화.md"
            panel.beginSheetModal(for:window) { response in
                if response == .OK, let url = panel.url {
                    do { try text.write(to:url, atomically:true, encoding:.utf8) }
                    catch { self.send(["type":"error", "message":"파일을 저장하지 못했습니다."]) }
                }
            }; return
        }
        if action == "importContext" {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = ["txt", "md", "csv", "json"].compactMap { UTType(filenameExtension:$0) }
            panel.allowsMultipleSelection = false
            panel.canChooseDirectories = false
            panel.beginSheetModal(for:window) { response in
                guard response == .OK, let url = panel.url else { return }
                do {
                    let attributes = try FileManager.default.attributesOfItem(atPath:url.path)
                    guard let size = attributes[.size] as? NSNumber, size.intValue <= 100000 else {
                        self.send(["type":"error", "message":"100KB 이하의 UTF-8 텍스트 파일을 선택해 주세요."]); return
                    }
                    let text = try String(contentsOf:url, encoding:.utf8)
                    guard text.utf16.count <= 16000 else {
                        self.send(["type":"error", "message":"참고 문맥은 최대 16,000자입니다. 필요한 부분만 붙여 넣어 주세요."]); return
                    }
                    self.send(["type":"contextFile", "text":text, "name":url.lastPathComponent])
                } catch { self.send(["type":"error", "message":"UTF-8 텍스트 파일을 읽지 못했습니다."]); }
            }; return
        }
        if action == "openData" {
            let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Dual Lens")
            NSWorkspace.shared.open(url); return
        }
        write(body)
    }
    func write(_ body:[String:Any]) {
        guard backend?.isRunning == true, let data = try? JSONSerialization.data(withJSONObject:body) else {
            send(["type":"error", "message":"연결 프로세스가 준비되지 않았습니다. 앱을 다시 열어 주세요."]); return
        }
        do { try input?.fileHandleForWriting.write(contentsOf:data + Data([10])) }
        catch { send(["type":"error", "message":"요청 전달에 실패했습니다."]) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        if navigationAction.navigationType == .linkActivated {
            if let url = navigationAction.request.url, ["https","http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel); return
        }
        decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
    }
    func applicationDidBecomeActive(_ notification:Notification) { if ready { setupStatus() } }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { true }
    func applicationWillTerminate(_ notification:Notification) {
        input?.fileHandleForWriting.closeFile()
        backend?.terminationHandler = nil
        backend?.terminate()
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
