import ClerkKit
import ClerkKitUI
import SwiftUI

@main
struct AMMApp: App {
  @State private var session = AppSession()

  init() {
    Clerk.configure(publishableKey: AMMConfiguration.clerkPublishableKey)
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .prefetchClerkImages()
        .environment(session)
        .environment(Clerk.shared)
        .tint(AMMColor.cobalt)
        .preferredColorScheme(.light)
    }
  }
}
