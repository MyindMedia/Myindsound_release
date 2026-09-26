import ClerkKit
import ConvexMobile
import Foundation

/// Hands Convex the Clerk JWT from the template named "convex" (aud: "convex"), the same token the web
/// site uses (src/convex.ts, convex/auth.config.ts). clerk-convex-swift's provider asks for Clerk's default
/// session token instead, which this deployment does not accept, so the app carries its own.
///
/// Convex calls `loginFromCache` again whenever it needs a fresh token (the Rust client's force refresh),
/// and Clerk's `getToken` answers from its cache until the token is about to expire.
@MainActor
final class ClerkConvexTokenProvider: AuthProvider {
    typealias T = String

    static let template = "convex"

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await token()
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await token()
    }

    /// Clerk's own sign out runs first (ClerkAuthBackend.signOut); nothing to do here.
    func logout() async throws {}

    nonisolated func extractIdToken(from authResult: String) -> String { authResult }

    private func token() async throws -> String {
        guard Clerk.shared.isLoaded else { throw APIError(code: "AUTH_LOADING", message: "Still loading your account.") }
        guard let session = Clerk.shared.session, session.status == .active else { throw APIError.unauthenticated }
        guard let token = try await session.getToken(.init(template: Self.template)) else {
            throw APIError(code: "NO_TOKEN", message: "Couldn't get a sign in token. Check the Clerk \"convex\" JWT template.")
        }
        return token
    }
}

/// AUTH-1 on Clerk iOS (ClerkKit 1.5): email code sign in and sign up, session restore, and keeping the
/// Convex client's auth in step with the Clerk session.
@MainActor
final class ClerkAuthBackend: AuthBackend {
    var onSignedOut: (() -> Void)?

    private let convex: ConvexClientWithAuth<String>
    private var signIn: SignIn?
    private var signUp: SignUp?
    private var eventsTask: Task<Void, Never>?

    init(convex: ConvexClientWithAuth<String>) {
        self.convex = convex
    }

    func restore() async -> Profile? {
        // Clerk loads its environment and saved client after configure; wait for it (bounded).
        for _ in 0..<100 where !Clerk.shared.isLoaded {
            try? await Task.sleep(for: .milliseconds(100))
        }
        listenForSessionChanges()
        guard Clerk.shared.session?.status == .active else { return nil }
        return await connectConvex()
    }

    func sendCode(to email: String, createAccount: Bool) async throws {
        signIn = nil
        signUp = nil
        if createAccount {
            do {
                try await startSignUp(email)
                return
            } catch let error as ClerkAPIError where error.code == "form_identifier_exists" {
                // Already has an account (the web checkout creates one): sign in instead.
            }
        }
        do {
            signIn = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: email)
        } catch let error as ClerkAPIError where ["form_identifier_not_found", "invitation_account_not_exists"].contains(error.code) {
            try await startSignUp(email)
        }
    }

    func verify(code: String) async throws -> Profile {
        if let signIn {
            let result = try await signIn.verifyCode(code)
            self.signIn = result
            guard result.status == .complete else {
                throw APIError(code: "INCOMPLETE", message: "This account needs another step. Sign in on stream.myindsound.com once, then try again.")
            }
        } else if let signUp {
            let result = try await signUp.verifyEmailCode(code)
            self.signUp = result
            guard result.status == .complete else {
                throw APIError(code: "INCOMPLETE", message: "Finish creating your account on stream.myindsound.com, then sign in here.")
            }
        } else {
            throw APIError(code: "NO_FLOW", message: "Request a new code.")
        }
        // The new session becomes the client's current one; give Clerk a beat to publish it.
        for _ in 0..<30 where Clerk.shared.session?.status != .active {
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard let profile = await connectConvex() else { throw APIError.unauthenticated }
        return profile
    }

    func resendCode() async throws {
        if let signIn {
            self.signIn = try await signIn.sendEmailCode()
        } else if let signUp {
            self.signUp = try await signUp.sendEmailCode()
        }
    }

    func signOut() async {
        try? await Clerk.shared.auth.signOut()
        await convex.logout()
        signIn = nil
        signUp = nil
    }

    // MARK: Private

    private func startSignUp(_ email: String) async throws {
        let created = try await Clerk.shared.auth.signUp(emailAddress: email)
        signUp = try await created.sendEmailCode()
    }

    /// Authenticates the Convex client with the current session's "convex" token.
    private func connectConvex() async -> Profile? {
        switch await convex.loginFromCache() {
        case .success:
            return currentProfile()
        case .failure:
            return nil
        }
    }

    private func currentProfile() -> Profile {
        let user = Clerk.shared.user
        return Profile(firstName: user?.firstName, email: user?.primaryEmailAddress?.emailAddress, userId: user?.id)
    }

    /// A session that ends elsewhere (revoked in the dashboard, deleted account) signs the app out too.
    private func listenForSessionChanges() {
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            for await event in Clerk.shared.auth.events {
                guard let self, !Task.isCancelled else { return }
                if case .sessionChanged(let old, let new) = event, old != nil, new == nil {
                    await self.convex.logout()
                    self.onSignedOut?()
                }
            }
        }
    }
}
