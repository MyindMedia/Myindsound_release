// swift-tools-version: 5.9
// MyindWear: Swift port of @myind/wear (PRD section 11). Clean-room port from
// packages/wear/README.md; proven byte identical against packages/wear/wear-vectors.json.
import PackageDescription

let package = Package(
  name: "MyindWear",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "MyindWear", targets: ["MyindWear"]),
  ],
  targets: [
    .target(name: "MyindWear", path: "Sources/MyindWear"),
    .testTarget(name: "MyindWearTests", dependencies: ["MyindWear"], path: "Tests/MyindWearTests"),
  ]
)
