// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ClaudeCacheStatusApp",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "ClaudeCacheStatusApp",
            targets: ["ClaudeCacheStatusApp"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "ClaudeCacheStatusApp"
        ),
    ]
)
