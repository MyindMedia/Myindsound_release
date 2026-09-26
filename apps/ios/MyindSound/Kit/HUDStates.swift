import SwiftUI

/// theme.css `.loading-spinner`: a ring in gold at 18 % with a gold top arc, turning once a second (about
/// 40 px across, 3 px stroke on the store page, docs/app-v1/bar/05). Under Reduce Motion it holds still.
struct HUDSpinner: View {
    var size: CGFloat = 40
    var stroke: CGFloat = 3
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            let turn = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1)
            ZStack {
                Circle().stroke(MSColor.gold.opacity(0.18), lineWidth: stroke)
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(MSColor.gold, style: StrokeStyle(lineWidth: stroke, lineCap: .butt))
                    .rotationEffect(.degrees(-135 + turn * 360))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The site's loading and empty states (physical.html "Loading products...", physical.ts empty and error
/// states): centred, Inter 16 in `muted`, under an optional spinner or LCD word.
struct HUDStateMessage: View {
    enum Kind {
        case loading
        case empty
        case error(retry: () -> Void)
    }

    let kind: Kind
    let message: String

    var body: some View {
        VStack(spacing: MSSpace.space16) {
            switch kind {
            case .loading:
                HUDSpinner()
            case .empty:
                EmptyView()
            case .error:
                LCDView(content: LCDContent("NO SIGNAL"))
                    .frame(width: 180)
            }
            Text(message)
                .font(MSFont.inter(16, weight: .regular))
                .foregroundStyle(MSColor.muted)
                .multilineTextAlignment(.center)
            if case .error(let retry) = kind {
                KeyButton("Try again", action: retry)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, MSSpace.space32)
        .padding(.vertical, MSSpace.space32)
        .accessibilityElement(children: .combine)
    }
}
