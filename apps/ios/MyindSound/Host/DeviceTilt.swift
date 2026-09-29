import CoreMotion
import Foundation

/// The phone's tilt for the 3D deck: CoreMotion's gravity at 30 Hz, measured against how the phone is being held
/// (a baseline that follows slowly, so any comfortable angle reads as level), as -1..1 left/right and
/// forward/back. The deck leans with the phone and nothing else (no idle sway, no drag lean; scene.ts
/// `setDeviceTilt`). Runs only while a page is on screen and the app is active.
@MainActor
final class DeviceTilt {
    /// How far the phone turns for a full lean, in gravity units (about 20 degrees).
    static let fullLean = 0.34
    /// How fast the level follows the way the phone is held, per sample (30 Hz: about 3 s).
    static let follow = 0.012

    private let motion = CMMotionManager()
    private var baseline: (x: Double, y: Double, z: Double)?
    private let send: (Double, Double) -> Void

    init(send: @escaping (Double, Double) -> Void) {
        self.send = send
    }

    var isRunning: Bool { motion.isDeviceMotionActive }

    func start() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        baseline = nil
        motion.deviceMotionUpdateInterval = 1.0 / 30
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let gravity = data?.gravity else { return }
            MainActor.assumeIsolated { self.sample(gravity) }
        }
    }

    func stop() {
        guard motion.isDeviceMotionActive else { return }
        motion.stopDeviceMotionUpdates()
        baseline = nil
        send(0, 0)
    }

    private func sample(_ g: CMAcceleration) {
        var base = baseline ?? (g.x, g.y, g.z)
        let lean = Self.lean(gravity: (g.x, g.y, g.z), baseline: base)
        base.x += (g.x - base.x) * Self.follow
        base.y += (g.y - base.y) * Self.follow
        base.z += (g.z - base.z) * Self.follow
        baseline = base
        send(lean.x, lean.y)
    }

    /// Left/right from gravity's x (roll), forward/back from its z (the screen facing up or away), each scaled to
    /// a full lean and clamped to -1..1.
    nonisolated static func lean(gravity g: (x: Double, y: Double, z: Double), baseline b: (x: Double, y: Double, z: Double)) -> (x: Double, y: Double) {
        let clamp = { (v: Double) in max(-1, min(1, v)) }
        return (clamp((g.x - b.x) / fullLean), clamp((b.z - g.z) / fullLean))
    }
}
