import SwiftUI

// The kit's one bridge onto packages/tokens/dist/Theme.swift. Everything here either forwards to a
// generated token or, where Theme.swift has no symbol yet, carries the literal from the live CSS/TS with
// its selector. The literals are the P8 report's token-gap list; when tokens gains them, forward here and
// nothing else in the kit changes.

/// Glows. Theme.swift's `MSGlowStyle` records CSS blur radii 1:1; a SwiftUI `.shadow(radius:)` of the same
/// number spreads about twice as far as the CSS blur, so the kit halves the radius on the way through
/// (`MSGlow.hudRadius`) to land on the same picture as the player.
enum HUDGlow {
    typealias Glow = MSGlow

    static let readout = MSGlowStyle.goldReadout
    static let trackTitle = MSGlowStyle.goldTrackTitle
    static let primaryPulse = MSGlowStyle.goldPrimaryPulse
    static let bootBar = MSGlowStyle.goldBootBar
    static let miniPlayerBar = MSGlowStyle.goldMiniPlayerBar
    static let float = MSGlowStyle.float
    static let floatLift = MSGlowStyle.floatLift
    static let iceHint = MSGlowStyle.iceInspectHint
    static let none = MSGlow(color: .clear, radius: 0, x: 0, y: 0)
}

extension MSGlow {
    /// CSS blur → SwiftUI shadow radius.
    var hudRadius: CGFloat { radius / 2 }
}

/// Surface alphas, sizes and hairlines. Forwarded where Theme.swift has them; literal (with source) where not.
enum HUDSurface {
    /// hud.css .p3d-track[aria-current]: `linear-gradient(90deg, rgba(253,185,19,0.16), transparent 80%)`.
    static let currentRowGradient = MSGradient.listRowCurrent
    /// The live row renders with an 8 px radius: src/style.css (the Vite scaffold) gives every `button`
    /// `border-radius: 8px`, and .p3d-track is a button (see docs/app-v1/bar/07). Theme.swift records it as
    /// `MSShape.strayGlobalButtonRadius`; the native row matches what fans see. Its #646cff hover border
    /// (the same stray stylesheet) is deliberately not copied.
    static let trackRowRadius = MSShape.strayGlobalButtonRadius
    /// hud.css .p3d-track:hover `rgba(253,185,19,0.07)`. GAP.
    static let rowPressedAlpha: Double = 0.07
    static let readoutDividerAlpha = MSComponent.ReadoutRow.dividerAlpha
    static let readoutDividerDash = MSComponent.ReadoutRow.dividerDashPattern
    static let bootTrackAlpha = MSComponent.BootLoader.trackBackgroundAlpha
    static let nowPlayingTrackAlpha = MSComponent.NowPlaying.barBackgroundAlpha
    /// ios.css .ios-tabbar `rgba(7,7,12,0.82)`; .ios-nav 0.7, scrolled 0.86. GAP: Theme.swift has the blur
    /// (`MSComponent.TabBar.blur`) but not the three alphas.
    static let tabBarAlpha: Double = 0.82
    static let navBarAlpha: Double = 0.7
    static let navBarScrolledAlpha: Double = 0.86
    static let tabInactive = MSColor.tabInactive
    static let groupedSeparator = MSComponent.GroupedList.separatorColor
    static let groupedSeparatorInset = MSComponent.GroupedList.actionRowSeparatorInset
    static let groupedChevron = MSComponent.GroupedList.chevronColor
    static let groupedChevronSize = MSComponent.GroupedList.chevronSize
    /// ios.css .action-card:active `rgba(253,185,19,0.14)`. GAP.
    static let groupedPressedAlpha: Double = 0.14
    static let groupedIconTile = MSComponent.GroupedList.iconTileSize
    static let groupedIconTileRadius = MSComponent.GroupedList.iconTileRadius
    static let groupedIconSize = MSComponent.GroupedList.iconSize
    /// ios.css .action-card `padding: 12px 14px; gap: 13px`. GAP.
    static let groupedRowPaddingV: CGFloat = 12
    static let groupedRowPaddingH: CGFloat = 14
    static let groupedRowGap: CGFloat = 13
    static let navBarHeight = MSComponent.TabBar.topBarHeightBase
    static let navHandover = MSComponent.TabBar.handoverScroll
    static let barBlur = MSComponent.TabBar.blur
    static let nowPlayingBlur = MSComponent.NowPlaying.blur
    static let nowPlayingRadius = MSComponent.NowPlaying.radius
    /// theme.css @media (max-width: 640px) .mini-player: `padding: 9px 10px; gap: 10px`. GAP: Theme.swift
    /// carries the desktop 10/12/12 only.
    static let nowPlayingPaddingV: CGFloat = 9
    static let nowPlayingPaddingH: CGFloat = 10
    static let nowPlayingGap: CGFloat = 10
    /// theme.css .mini-player__disc: 78 % of the art box. GAP.
    static let nowPlayingDiscScale: CGFloat = 0.78
    static let primaryButtonPaddingH = MSComponent.PrimaryButton.paddingHorizontal
    static let keyButtonPaddingH = MSComponent.KeyButton.paddingHorizontal
    /// hud.css .p3d-track: grid `28px 1fr auto auto`, `padding: 6px 8px`. GAP (gap 10 is tokenised).
    static let trackNumberWidth: CGFloat = 28
    static let trackRowPaddingV: CGFloat = 6
    static let trackRowPaddingH: CGFloat = 8
    static let trackRowGap = MSComponent.ListRow.gap
    /// hud.css .p3d-track__eq: 3 px bars in a 14x12 box, `0.9s steps(6) infinite alternate`. Offsets,
    /// resting heights and keyframes come from `MSEQ`; the box, bar width and timing are GAP literals.
    static let eqBarWidth: CGFloat = 3
    static let eqBoxWidth: CGFloat = 14
    static let eqBoxHeight: CGFloat = 12
    static let eqBarOffsets = MSEQ.barXOffsets
    static let eqRestHeights: [CGFloat] = MSEQ.restHeightsPct.map { $0 / 100 }
    static let eqKeyframes: [[CGFloat]] = MSEQ.keyframes.map { $0.heightsPct.map { $0 / 100 } }
    static let eqDuration: Double = 0.9
    static let eqSteps = 6
    static let bootTrackMaxWidth = MSComponent.BootLoader.trackWidthMax
    static let bootTrackWidthFraction = MSComponent.BootLoader.trackWidthMaxPct / 100
    static let bootTerminalMaxWidth = MSComponent.BootLoader.terminalWidthMax
    static let bootTerminalWidthFraction = MSComponent.BootLoader.terminalWidthMaxPct / 100
    static let bootGap = MSComponent.BootLoader.gap
    /// hud.css .p3d-terminal color `rgba(253,185,19,0.9)`. GAP (the prefix colour is tokenised).
    static let terminalAlpha: Double = 0.9
    static let terminalPrefix = MSComponent.BootLoader.terminalPrefixColor
    static let terminalLineHeight = MSComponent.BootLoader.terminalLineHeight
    /// ios.css large title block `padding: 4px 20px 14px`; subtitle margin-top 6. GAP.
    static let largeTitlePaddingTop: CGFloat = 4
    static let largeTitlePaddingH: CGFloat = 20
    static let largeTitlePaddingBottom: CGFloat = 14
    static let largeTitleSubtitleGap: CGFloat = 6
    /// ios.css .section-header `padding: 0 20px 7px`; .dashboard-section margin-bottom 26. GAP.
    static let sectionLabelPaddingBottom: CGFloat = 7
    static let sectionGap = MSSpace.space26
    static let siteTickSize = MSComponent.SiteCard.cornerTickSize
    static let siteTickStroke = MSComponent.SiteCard.cornerTickStroke
    static let siteTickColor = MSComponent.SiteCard.cornerTickColor
    /// hud.css .p3d-sheet-toggle grabber: DS-19 names a grabber; the web sheet has a chevron. 36x5 is the
    /// iOS system grabber size. GAP (design decision, not CSS).
    static let sheetGrabberSize = CGSize(width: 36, height: 5)
}

/// Type roles. Forwarded to `MSFont.Style` where present; literal with source where not.
enum HUDType {
    static let panelMeta = MSFont.Style.panelMeta
    static let panelMetaTracking: CGFloat = 10 * MSFont.Tracking.monoDefaultEm
    static let readoutValue = MSFont.Style.readoutValue
    static let readoutValueTracking: CGFloat = 14 * MSFont.Tracking.monoDefaultEm
    static let trackTitle = MSFont.Style.trackTitle
    static let trackNumber = MSFont.Style.trackNumDur
    static let trackNumberTracking: CGFloat = 12 * MSFont.Tracking.monoDefaultEm
    static let primaryButton = MSFont.Style.primaryButton
    static let primaryButtonTracking = MSFont.Tracking.primaryButton
    static let repeatButton = MSFont.Style.repeatButton
    static let repeatButtonTracking = MSFont.Tracking.repeatButton
    /// hud.css .p3d-boot + .p3d-mono: mono 12, tracking 0.24em (sizes tokenised, no Font style). GAP.
    static let bootPercent = MSFont.mono(MSComponent.BootLoader.textSize, weight: .medium)
    static let bootPercentTracking: CGFloat = MSComponent.BootLoader.textSize * MSComponent.BootLoader.textTracking
    static let terminal = MSFont.mono(MSComponent.BootLoader.terminalTextSize, weight: .medium)
    static let terminalTracking: CGFloat = MSComponent.BootLoader.terminalTextSize * MSComponent.BootLoader.terminalTracking
    /// theme.css .mini-player__title: 12px 600 tracking 0.06em (Inter, the site body font). GAP.
    static let nowPlayingTitle = MSFont.inter(12, weight: .semibold)
    static let nowPlayingTitleTracking: CGFloat = 12 * 0.06
    /// theme.css .mini-player__meta: mono 10 tracking 0.14em uppercase. GAP.
    static let nowPlayingMeta = MSFont.mono(10, weight: .medium)
    static let nowPlayingMetaTracking: CGFloat = 10 * 0.14
    /// ios.css .dashboard-subtitle: 15px muted. GAP.
    static let largeTitleSubtitle = MSFont.inter(15, weight: .regular)
    /// ios.css .section-label: 12px 600 tracking 0.14em muted (mono via theme.css instrument labels). GAP
    /// (tracking is tokenised as `MSFont.Tracking.sectionLabel`).
    static let sectionLabel = MSFont.mono(12, weight: .semibold)
    /// ios.css .action-info h3: 16px 600 tracking -0.01em; p: 13px muted. GAP.
    static let groupedTitle = MSFont.inter(16, weight: .semibold)
    static let groupedTitleTracking: CGFloat = 16 * -0.01
    static let groupedSubtitle = MSFont.inter(13, weight: .regular)
    static let sheetTitle = MSFont.Style.sheetToggleLabel
    static let sheetTitleTracking = MSFont.Tracking.sheetToggleLabel
    /// hud.css .p3d-inspect-hint + .p3d-mono: 11px 600 tracking 0.18em ice. GAP.
    static let hint = MSFont.mono(11, weight: .semibold)
    static let hintTracking: CGFloat = 11 * 0.18
    /// theme.css body.ios-app .product-name 13px 600 -0.01em; .product-price mono 13. GAP.
    static let productName = MSFont.inter(13, weight: .semibold)
    static let productNameTracking: CGFloat = 13 * -0.01
    static let productPrice = MSFont.mono(13, weight: .medium)
    static let productPriceTracking: CGFloat = 13 * MSFont.Tracking.monoDefaultEm
}

// MARK: - Motion helpers (DS-28 to DS-30)

enum HUDMotion {
    /// DS-30: with Reduce Motion on, everything collapses to `MSMotion.reducedMotionFallback` (nil, a cut).
    static func animation(_ base: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? MSMotion.reducedMotionFallback : base
    }

    /// DS-14: the 1.8 s round trip, 0.9 s each way.
    static let pulse = MSMotion.pulseCycle
    /// ios.css .ios-nav__title: 0.28 s on the standard curve. GAP.
    static let navHandover = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.28)
}

/// DS-29 press feedback: scale on press with the standard curve. `scale` defaults to the tile value (0.97).
struct HUDPressStyle: ButtonStyle {
    var scale: CGFloat = MSMotion.PressScale.tile
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(HUDMotion.animation(MSMotion.standard, reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

// MARK: - View helpers

extension View {
    func hudGlow(_ glow: MSGlow) -> some View {
        shadow(color: glow.color, radius: glow.hudRadius, x: glow.x, y: glow.y)
    }

    /// DS-21: 2 pt gold ring on focus (keyboard / Full Keyboard Access), 2 pt outside the control.
    func hudFocusRing(offset: CGFloat = MSShape.focusRingOffset) -> some View {
        modifier(HUDFocusRing(offset: offset))
    }
}

private struct HUDFocusRing: ViewModifier {
    var offset: CGFloat
    @Environment(\.isFocused) private var isFocused

    func body(content: Content) -> some View {
        content.overlay {
            if isFocused {
                Rectangle()
                    .stroke(MSColor.gold, lineWidth: MSShape.focusRingWidth)
                    .padding(-offset)
            }
        }
    }
}

// MARK: - Text roles

/// DS-8 label: mono 11 semibold, uppercase, tracking 0.14em, muted (or gold).
struct HUDLabel: View {
    let text: String
    var color: Color = MSColor.muted

    init(_ text: String, color: Color = MSColor.muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text.uppercased())
            .font(MSFont.Style.label)
            .tracking(MSFont.Tracking.label)
            .foregroundStyle(color)
            .monospacedDigit()
    }
}

/// DS-9 panel title: Inter 800, 13, uppercase, tracking 0.16em, gold.
struct HUDPanelTitle: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(MSFont.Style.panelTitle)
            .tracking(MSFont.Tracking.panelTitle)
            .foregroundStyle(MSColor.gold)
    }
}

/// Panel meta (hud.css .p3d-panel__meta.p3d-mono): mono 10, muted.
struct HUDPanelMeta: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(HUDType.panelMeta)
            .tracking(HUDType.panelMetaTracking)
            .foregroundStyle(MSColor.muted)
            .monospacedDigit()
    }
}

/// ios.css .section-label above a grouped list: mono 12 semibold, tracking 0.14em, muted.
struct HUDSectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(HUDType.sectionLabel)
            .tracking(MSFont.Tracking.sectionLabel)
            .foregroundStyle(MSColor.muted)
            .padding(.horizontal, HUDSurface.largeTitlePaddingH)
            .padding(.bottom, HUDSurface.sectionLabelPaddingBottom)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// DS-12 large title block: Inter 800 34, ALL CAPS with tight tracking (ios.css .dashboard-title /
/// .merch-title: `34px 800, line-height 1.05, letter-spacing -0.02em`, uppercased on the live pages, see
/// docs/app-v1/bar/05), with the greeting as a muted subtitle.
struct HUDLargeTitle: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: HUDSurface.largeTitleSubtitleGap) {
            Text(title.uppercased())
                .font(MSFont.Style.largeTitle)
                .tracking(MSFont.Tracking.largeTitle)
                .foregroundStyle(MSColor.text)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            if let subtitle {
                Text(subtitle)
                    .font(HUDType.largeTitleSubtitle)
                    .foregroundStyle(MSColor.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, HUDSurface.largeTitlePaddingTop)
        .padding(.horizontal, HUDSurface.largeTitlePaddingH)
        .padding(.bottom, HUDSurface.largeTitlePaddingBottom)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
