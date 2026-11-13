import ClerkKit
import ClerkKitUI
import SwiftUI

struct RootView: View {
  @Environment(Clerk.self) private var clerk
  @Environment(AppSession.self) private var session
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      if clerk.user == nil {
        SignInGate()
      } else {
        DeskScreen()
      }
    }
    .background(AMMColor.paper.ignoresSafeArea())
    .task(id: clerk.user?.id) {
      guard let userID = clerk.user?.id else {
        session.reset()
        return
      }
      await session.loadDesk(userID: userID)
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active, clerk.user != nil else { return }
      Task { await session.refreshDesk() }
    }
  }
}
private struct SignInGate: View {
  var body: some View {
    ZStack {
      AMMColor.paper.ignoresSafeArea()
      VStack(spacing: 28) {
        Spacer()
        AMMWordmark(size: 44)
        VStack(spacing: 10) {
          Text("Your research desk,\nready to talk.")
            .font(.system(size: 42, weight: .black, design: .rounded))
            .multilineTextAlignment(.center)
          Text("Verified company files. One clear thesis. Voice when your hands are busy.")
            .font(.system(size: 17))
            .foregroundStyle(AMMColor.muted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 28)
        }
        Spacer()
        AuthView(isDismissible: false)
          .frame(maxHeight: 500)
          .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
          .ammCardShadow(depth: 6)
          .padding(.horizontal, 18)
          .padding(.bottom, 12)
      }
    }
  }
}
