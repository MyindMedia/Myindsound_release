import SwiftUI

/// Sign in (PRD 4A.9, AUTH-1): the site's login page (docs/app-v1/bar/06) as a HUD panel over the city,
/// with Clerk's email code flow behind it. The Myind Sound mark, GET ACCESS in Inter 800, the mono
/// subtitle, SIGN IN / SIGN UP as latching keys, then the email and the six digit code. One pulsing CTA.
struct SignInScreen: View {
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var code = ""
    @State private var createAccount = false
    @FocusState private var focused: Field?

    enum Field { case email, code }

    private var auth: AuthModel { app.auth }

    var body: some View {
        ZStack {
            HUDBackdrop()
            ScrollView {
                panel
                    .padding(.horizontal, MSSpace.space32)
                    .padding(.top, 72)
                    .padding(.bottom, MSSpace.space32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            Image("MyindLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .padding(.top, MSSpace.space28)
                .accessibilityLabel("Myind Sound")
            Text("GET ACCESS")
                .font(MSFont.inter(32, weight: .extrabold))
                .tracking(32 * 0.04)
                .foregroundStyle(MSColor.text)
                .padding(.top, MSSpace.space24)
                .accessibilityAddTraits(.isHeader)
            Text("SIGN IN TO ACCESS YOUR PURCHASED RELEASES AND STREAM YOUR LIBRARY")
                .font(MSFont.mono(12, weight: .medium))
                .tracking(12 * 0.08)
                .lineSpacing(4)
                .multilineTextAlignment(.center)
                .foregroundStyle(MSColor.muted)
                .padding(.top, MSSpace.space12)

            modeKeys
                .padding(.top, MSSpace.space28)

            form
                .padding(.top, MSSpace.space24)

            if let error = auth.error {
                Text(error)
                    .font(MSFont.mono(12, weight: .medium))
                    .foregroundStyle(MSColor.destructive)
                    .multilineTextAlignment(.center)
                    .padding(.top, MSSpace.space14)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if !auth.available {
                Text("SIGN IN ISN'T SET UP IN THIS BUILD")
                    .font(HUDType.panelMeta)
                    .foregroundStyle(MSColor.muted)
                    .padding(.top, MSSpace.space14)
            }
            #if DEBUG
            // Debug builds only: run on the sample data (MockAPI, as `-mock`) without an account, so the app
            // can be tried on a device before the Clerk dashboard is set up. Never in Release.
            KeyButton("Preview with sample data", fullWidth: true) { AppSession.enterSampleData() }
                .padding(.top, MSSpace.space20)
            #endif
        }
        .padding(.horizontal, MSSpace.space12)
        .padding(.bottom, MSSpace.space32)
        .frame(maxWidth: 420)
        .background {
            ZStack {
                MSColor.panel
                HUDScanlines()
            }
        }
        .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
        .hudCornerTicks(corners: [.topLeading], size: MSComponent.SiteCard.cornerTickSize, stroke: MSComponent.SiteCard.cornerTickStroke * 2, color: MSColor.gold)
    }

    /// The site's SIGN IN / SIGN UP tabs: latched gold, the other ink with a hairline.
    private var modeKeys: some View {
        HStack(spacing: 0) {
            KeyButton("Sign in", latched: !createAccount, fullWidth: true) { createAccount = false }
            KeyButton("Sign up", latched: createAccount, fullWidth: true) { createAccount = true }
        }
        .disabled(auth.step != .email)
    }

    @ViewBuilder
    private var form: some View {
        switch auth.step {
        case .email:
            VStack(alignment: .leading, spacing: MSSpace.space8) {
                HUDLabel("Email")
                TextField("", text: $email, prompt: Text(verbatim: "you@example.com").foregroundStyle(MSColor.muted.opacity(0.6)))
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($focused, equals: .email)
                    .onSubmit { Task { await auth.sendCode(email: email, createAccount: createAccount) } }
                    .hudField()
                HStack {
                    Spacer()
                    PrimaryButton(auth.busy ? "Sending" : "Send Code") {
                        Task { await auth.sendCode(email: email, createAccount: createAccount) }
                    }
                    .disabled(auth.busy || !auth.available)
                    Spacer()
                }
                .padding(.top, MSSpace.space16)
            }
        case .code(let sentTo):
            VStack(alignment: .leading, spacing: MSSpace.space8) {
                HUDLabel("Code sent to \(sentTo)")
                TextField("", text: $code, prompt: Text(verbatim: "000000").foregroundStyle(MSColor.muted.opacity(0.6)))
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(MSFont.mono(22, weight: .semibold))
                    .tracking(22 * 0.3)
                    .focused($focused, equals: .code)
                    .onChange(of: code) { _, value in
                        code = String(value.filter(\.isNumber).prefix(6))
                        if code.count == 6 { Task { await auth.verify(code: code) } }
                    }
                    .hudField()
                HStack {
                    Spacer()
                    PrimaryButton(auth.busy ? "Checking" : "Verify") { Task { await auth.verify(code: code) } }
                        .disabled(auth.busy)
                    Spacer()
                }
                .padding(.top, MSSpace.space16)
                HStack {
                    Button("RESEND CODE") { Task { await auth.resend() } }
                    Spacer()
                    Button("DIFFERENT EMAIL") {
                        code = ""
                        auth.useDifferentEmail()
                    }
                }
                .font(HUDType.panelMeta)
                .tracking(HUDType.panelMetaTracking * 2)
                .foregroundStyle(MSColor.gold)
                .frame(minHeight: MSShape.minTouchTarget)
                .padding(.top, MSSpace.space8)
            }
            .onAppear { focused = .code }
        }
    }
}

extension View {
    /// A text field in the HUD: `base` fill, `lineDim` hairline (gold when focused would need focus state;
    /// the caret is gold via the app tint), Inter 16 cream, 48 pt tall.
    func hudField() -> some View {
        self
            .font(MSFont.inter(16, weight: .regular))
            .foregroundStyle(MSColor.text)
            .padding(.horizontal, MSSpace.space14)
            .frame(minHeight: MSComponent.PrimaryButton.minHeight)
            .background(MSColor.base.opacity(0.85))
            .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
    }
}
