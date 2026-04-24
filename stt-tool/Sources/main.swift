// stt-tool — Transcribe audio files using Apple's on-device SFSpeechRecognizer
// Usage: stt-tool <path-to-audio-file>
// Outputs JSON: {"text": "transcribed text"}
//
// Keeps the latest partial result continuously, so even if the task doesn't
// emit `isFinal` (common for long clips or rough audio), we still return the
// best transcription we have when the timeout hits.

import Foundation
import Speech
import AVFoundation

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: stt-tool <audio-file>\n", stderr)
    exit(1)
}

let filePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: filePath)

guard FileManager.default.fileExists(atPath: filePath) else {
    fputs("Error: File not found: \(filePath)\n", stderr)
    exit(1)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
    fputs("Error: Could not create speech recognizer\n", stderr)
    print("{\"text\": \"\"}")
    exit(0)
}

let request = SFSpeechURLRecognitionRequest(url: fileURL)
request.shouldReportPartialResults = true

if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
    fputs("Using on-device recognition\n", stderr)
}

// Timeout from env (seconds). Default 60 — long enough for a full minute of
// audio. Previously 10s, which silently truncated any recording over 10s.
let timeoutEnv = ProcessInfo.processInfo.environment["STT_TIMEOUT_SECONDS"]
let timeoutSeconds: Double = Double(timeoutEnv ?? "") ?? 60.0

var finished = false
var bestText: String = ""  // longest partial transcription seen so far

@Sendable func escape(_ text: String) -> String {
    return text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
}

func finishAndExit() {
    if finished { return }
    finished = true
    print("{\"text\": \"\(escape(bestText))\"}")
    CFRunLoopStop(CFRunLoopGetMain())
}

recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        // Continuously track the best partial. Apple STT's partials grow
        // monotonically in most cases, but fall back to longest-wins in case
        // a partial ever comes back shorter.
        let text = result.bestTranscription.formattedString
        if text.count >= bestText.count {
            bestText = text
        }
        if result.isFinal {
            finishAndExit()
        }
    }
    if let error = error {
        if !finished {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            // Still return whatever partial we have, not empty
            finishAndExit()
        }
    }
}

DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds) {
    if !finished {
        fputs("Timeout after \(timeoutSeconds)s — returning best partial\n", stderr)
        finishAndExit()
    }
}

// Run the main RunLoop so callbacks can fire
CFRunLoopRun()
