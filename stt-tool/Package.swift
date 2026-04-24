// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "stt-tool",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "stt-tool", path: "Sources")
    ]
)
