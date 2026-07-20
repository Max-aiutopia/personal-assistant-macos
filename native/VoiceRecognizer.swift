import AVFoundation
import Foundation
import Speech

final class VoiceRecognizer {
    private let silenceTimeout: TimeInterval = 3
    private let maximumListeningTime: TimeInterval = 30
    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-TW"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceWorkItem: DispatchWorkItem?
    private var maximumWorkItem: DispatchWorkItem?
    private var latestText = ""
    private var hasFinished = false
    private var outputHandle: FileHandle?
    private let preferOnDevice: Bool

    // 領域詞彙偏置：提升助理名稱、指令動詞、時間用語等專有名詞的辨識命中率
    private static let contextualVocabulary = [
        "小光", "小幫手", "助理",
        "提醒", "提醒我", "新增", "加入", "待辦", "行程", "會議", "約會", "拍攝",
        "日誌", "記錄", "完成", "做完", "刪除", "取消", "移除",
        "今天", "明天", "後天", "下週", "這週", "早上", "上午", "中午", "下午", "傍晚", "晚上",
        "打電話", "回覆", "客戶", "報告", "開會", "健身", "運動", "吃藥", "繳費", "打掃"
    ]

    init() {
        let arguments = CommandLine.arguments
        preferOnDevice = arguments.contains("--on-device")
        if
            let outputIndex = arguments.firstIndex(of: "--output-file"),
            arguments.indices.contains(outputIndex + 1)
        {
            let outputPath = arguments[outputIndex + 1]
            FileManager.default.createFile(atPath: outputPath, contents: nil)
            outputHandle = FileHandle(forWritingAtPath: outputPath)
        }
    }

    // 只請求權限後立刻結束（供 App 啟動時在主視窗前面預先取得授權，避免之後被浮動視窗擋住對話框）
    func requestPermissionsOnly() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                self?.emit(
                    type: "permission",
                    message: "speech=\(status.rawValue) mic=\(granted)"
                )
                self?.finish(exitCode: 0)
            }
        }
    }

    func start() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                self?.emit(type: "error", message: "需要允許語音辨識權限。")
                self?.finish(exitCode: 2)
                return
            }

            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else {
                    self?.emit(type: "error", message: "需要允許麥克風權限。")
                    self?.finish(exitCode: 3)
                    return
                }

                DispatchQueue.main.async {
                    self?.beginRecognition()
                }
            }
        }
    }

    private func beginRecognition() {
        guard let recognizer, recognizer.isAvailable else {
            emit(type: "error", message: "macOS 語音辨識目前無法使用。")
            finish(exitCode: 4)
            return
        }

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.taskHint = .unspecified
        if #available(macOS 13.0, *) {
            recognitionRequest.addsPunctuation = true
        }
        recognitionRequest.contextualStrings = VoiceRecognizer.contextualVocabulary
        // 預設用伺服器端辨識（中文準確度明顯較高）；僅在隱私模式（--on-device）才強制裝置端。
        if preferOnDevice, recognizer.supportsOnDeviceRecognition {
            recognitionRequest.requiresOnDeviceRecognition = true
        }
        request = recognitionRequest

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(type: "error", message: "無法啟動麥克風。")
            finish(exitCode: 5)
            return
        }

        emit(type: "ready")
        resetSilenceTimer()
        let maximumWorkItem = DispatchWorkItem { [weak self] in
            self?.finishWithLatestText()
        }
        self.maximumWorkItem = maximumWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + maximumListeningTime, execute: maximumWorkItem)

        task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, !self.hasFinished else { return }

                if let result {
                    let recognizedText = result.bestTranscription.formattedString
                    let textChanged = recognizedText != self.latestText
                    if textChanged {
                        self.latestText = recognizedText
                        self.emit(type: result.isFinal ? "final" : "partial", text: self.latestText)
                        self.resetSilenceTimer()
                    }
                    if result.isFinal {
                        if self.latestText.isEmpty {
                            self.emit(type: "error", message: "3 秒內沒有聽到聲音，已自動結束。")
                            self.finish(exitCode: 7)
                            return
                        }
                        if !textChanged {
                            self.emit(type: "final", text: self.latestText)
                        }
                        self.finish(exitCode: 0)
                        return
                    }
                }

                if error != nil {
                    if self.latestText.isEmpty {
                        self.emit(type: "error", message: "這次沒有辨識到語音，請再試一次。")
                    } else {
                        self.emit(type: "final", text: self.latestText)
                    }
                    self.finish(exitCode: self.latestText.isEmpty ? 6 : 0)
                }
            }
        }
    }

    private func resetSilenceTimer() {
        silenceWorkItem?.cancel()
        let silenceWorkItem = DispatchWorkItem { [weak self] in
            self?.finishWithLatestText()
        }
        self.silenceWorkItem = silenceWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + silenceTimeout, execute: silenceWorkItem)
    }

    private func finishWithLatestText() {
        if latestText.isEmpty {
            emit(type: "error", message: "3 秒內沒有聽到聲音，已自動結束。")
            finish(exitCode: 7)
        } else {
            emit(type: "final", text: latestText)
            finish(exitCode: 0)
        }
    }

    private func finish(exitCode: Int32) {
        guard !hasFinished else { return }
        hasFinished = true
        silenceWorkItem?.cancel()
        maximumWorkItem?.cancel()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        try? outputHandle?.synchronize()
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
            try? self.outputHandle?.close()
            exit(exitCode)
        }
    }

    private func emit(type: String, text: String? = nil, message: String? = nil) {
        var payload = [
            "type": type,
            "pid": String(ProcessInfo.processInfo.processIdentifier)
        ]
        if let text { payload["text"] = text }
        if let message { payload["message"] = message }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let line = String(data: data, encoding: .utf8)
        else { return }
        if
            let outputHandle,
            let rendered = "\(line)\n".data(using: .utf8)
        {
            outputHandle.write(rendered)
            try? outputHandle.synchronize()
        } else {
            print(line)
            fflush(stdout)
        }
    }
}

let voiceRecognizer = VoiceRecognizer()
if CommandLine.arguments.contains("--request-permission") {
    voiceRecognizer.requestPermissionsOnly()
} else {
    voiceRecognizer.start()
}
dispatchMain()
