import Foundation
import Observation

/// Who is signed in, as the screens need it. The email is shown to its owner on the account screen only and
/// never logged (compliance: no PII in logs).
struct Profile: Equatable {
    var firstName: String?
    var email: String?
    /// The auth provider's user id. Only ever used hashed (download folder and key names), never logged.
    var userId: String? = nil
}

/// The auth system behind `AuthModel`: Clerk for real runs, a stand-in for `-mock`.
@MainActor
protocol AuthBackend: AnyObject {
    /// Finishes loading any saved session. Returns the profile when a session is active (and the data
    /// client is authenticated with it), nil when signed out.
    func restore() async -> Profile?
    /// Starts an email code sign in, or a sign up when `createAccount` is true or no account exists.
    func sendCode(to email: String, createAccount: Bool) async throws
    /// Checks the code. Returns the profile once the session is active.
    func verify(code: String) async throws -> Profile
    func resendCode() async throws
    func signOut() async
    /// Called when the session ends somewhere else (revoked, deleted, expired).
    var onSignedOut: (() -> Void)? { get set }
}

/// AUTH-1 sign in state for the whole app: the email code flow of the HUD sign in panel (PRD 4A.9).
@MainActor
@Observable
final class AuthModel {
    enum State: Equatable {
        case loading
        case signedOut
        case signedIn(Profile)
    }

    enum Step: Equatable {
        case email
        case code(email: String)
    }

    private(set) var state: State = .loading
    private(set) var step: Step = .email
    private(set) var busy = false
    var error: String?
    /// Whether the backend can sign anyone in at all (a build without a Clerk key cannot).
    let available: Bool

    private let backend: AuthBackend?

    init(backend: AuthBackend?) {
        self.backend = backend
        self.available = backend != nil
        backend?.onSignedOut = { [weak self] in
            self?.state = .signedOut
            self?.step = .email
        }
    }

    var profile: Profile? {
        if case .signedIn(let profile) = state { return profile }
        return nil
    }

    var isSignedIn: Bool { profile != nil }

    func restore() async {
        guard let backend else {
            state = .signedOut
            return
        }
        if let profile = await backend.restore() {
            state = .signedIn(profile)
        } else {
            state = .signedOut
        }
    }

    func sendCode(email: String, createAccount: Bool) async {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("@"), trimmed.contains(".") else {
            error = "Enter the email you bought with."
            return
        }
        await run {
            try await self.backend?.sendCode(to: trimmed, createAccount: createAccount)
            self.step = .code(email: trimmed)
        }
    }

    func verify(code: String) async {
        let digits = code.filter(\.isNumber)
        guard digits.count == 6 else {
            error = "Enter the 6 digit code from the email."
            return
        }
        await run {
            guard let backend = self.backend else { return }
            let profile = try await backend.verify(code: digits)
            self.state = .signedIn(profile)
            self.step = .email
        }
    }

    func resend() async {
        await run { try await self.backend?.resendCode() }
    }

    func useDifferentEmail() {
        error = nil
        step = .email
    }

    func signOut() async {
        await backend?.signOut()
        state = .signedOut
        step = .email
    }

    private func run(_ body: @escaping () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await body()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
        }
    }
}

/// `-mock`: signed in as a sample fan, or (for the sign in screenshot) signed out with a flow that accepts
/// any six digits.
@MainActor
final class MockAuthBackend: AuthBackend {
    var startSignedIn: Bool
    var onSignedOut: (() -> Void)?
    static let profile = Profile(firstName: "Lawrence", email: nil, userId: "mock-fan")

    init(startSignedIn: Bool) {
        self.startSignedIn = startSignedIn
    }

    func restore() async -> Profile? { startSignedIn ? Self.profile : nil }
    func sendCode(to email: String, createAccount: Bool) async throws {}
    func verify(code: String) async throws -> Profile { Self.profile }
    func resendCode() async throws {}
    func signOut() async {}
}
