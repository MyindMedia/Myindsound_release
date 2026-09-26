import SwiftUI

/// STORE (PRD 4A.9): the site store's page (physical.html) in the phone shell. Shopify isn't wired to the
/// app yet (STORE-*), so it shows exactly what the site shows around its grid: the loading state
/// ("Loading products...", physical.html) and then the empty state (physical.ts `showEmpty`), never
/// invented products. When the Storefront query lands it fills the DS-20 floating grid (FloatingTile +
/// ProductTileBody) in place of the empty state.
struct StoreScreen: View {
    /// `-screen store-loading` pins the loading state for screenshots.
    var holdLoading = false

    @State private var state: StoreState = .loading

    enum StoreState: Equatable {
        case loading
        case empty
    }

    var body: some View {
        HUDPage(title: "Physical Releases", subtitle: "Premium merchandise and collectibles") {
            switch state {
            case .loading:
                HUDStateMessage(kind: .loading, message: "Loading products...")
                    .padding(.top, MSSpace.space36)
            case .empty:
                HUDStateMessage(kind: .empty, message: "No products available yet. Check back soon!")
                    .padding(.top, MSSpace.space36)
            }
        }
        .task {
            guard !holdLoading else { return }
            // No product source yet: the same short load, then the site's empty state.
            try? await Task.sleep(for: .milliseconds(900))
            state = .empty
        }
    }
}
