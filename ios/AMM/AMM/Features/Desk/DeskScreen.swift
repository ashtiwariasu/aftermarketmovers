import ClerkKitUI
import SwiftUI

struct DeskScreen: View {
  @Environment(AppSession.self) private var session
  @State private var showingCompanies = false

  var body: some View {
    @Bindable var session = session

    NavigationStack {
      ZStack {
        AMMColor.paper.ignoresSafeArea()
        PaperNoise()
        content
      }
      .toolbar(.hidden, for: .navigationBar)
      .refreshable {
        await session.refreshDesk()
      }
      .sheet(isPresented: $showingCompanies) {
        DeskSetupView(
          mode: .manage,
          initialTickers: session.desk?.desk.tickers ?? []
        ) {
          showingCompanies = false
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch session.state {
    case .idle where session.desk == nil:
      LoadingDeskView()
    case .loading where session.desk == nil:
      LoadingDeskView()
    case .needsDesk:
      DeskSetupView(mode: .onboarding)
    case .failed(let message) where session.desk == nil:
      ErrorStateView(message: message) {
        Task { await session.refreshDesk() }
      }
    default:
      deskContent
    }
  }

  private var deskContent: some View {
    ScrollView {
      LazyVStack(spacing: 24) {
        deskHeader

        if let syncMessage = session.syncMessage {
          SavedDeskBanner(message: syncMessage) {
            Task { await session.refreshDesk() }
          }
        }

        if let card = session.selectedCard {
          VoiceHeroView(card: card, allowance: session.desk?.voice)
            .id(card.ticker)
        }

        cardsSection
      }
      .padding(.horizontal, 18)
      .padding(.top, 10)
      .padding(.bottom, 42)
    }
    .scrollIndicators(.hidden)
  }

  private var deskHeader: some View {
    HStack {
      VStack(alignment: .leading, spacing: 8) {
        AMMWordmark(size: 25)
        Text(greeting)
          .font(.system(size: 32, weight: .black, design: .rounded))
          .foregroundStyle(AMMColor.ink)
      }
      Spacer()
      Button {
        showingCompanies = true
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 15, weight: .black))
          .foregroundStyle(.white)
          .frame(width: 42, height: 42)
          .background(AMMColor.ink)
          .clipShape(Circle())
      }
      .accessibilityLabel("Manage companies")
      UserButton()
        .frame(width: 42, height: 42)
    }
  }

  private var cardsSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        AMMMonoLabel(text: "Today’s company files", color: AMMColor.orange)
        Spacer()
        Text("\(max(1, session.selectedCardIndex + 1))/\(max(1, session.cards.count))")
          .font(.system(size: 12, weight: .semibold, design: .monospaced))
          .foregroundStyle(AMMColor.muted)
      }

      if session.cards.isEmpty {
        EmptyDeskCard()
      } else {
        TabView(selection: Binding(
          get: { session.selectedCardIndex },
          set: { newValue in
            session.selectedCardIndex = newValue
            if session.cards.indices.contains(newValue) {
              session.select(session.cards[newValue])
            }
          }
        )) {
          ForEach(Array(session.cards.enumerated()), id: \.element.id) { index, card in
            NavigationLink {
              StockScreen(ticker: card.ticker)
            } label: {
              DeskDecisionCard(card: card)
            }
            .buttonStyle(.plain)
            .tag(index)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: 600)
      }
    }
  }

  private var greeting: String {
    let hour = Calendar.current.component(.hour, from: Date())
    let salutation = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening"
    let name = session.desk?.member.firstName ?? "there"
    return "\(salutation), \(name)."
  }
}

private struct DeskDecisionCard: View {
  let card: DeskCard

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(card.ticker)
          .font(.system(size: 32, weight: .black, design: .rounded))
          .foregroundStyle(AMMColor.cobalt)
        Spacer()
        Text(card.date)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(AMMColor.muted)
      }
      .padding(.bottom, 12)

      Divider().overlay(AMMColor.rule)

      VStack(alignment: .leading, spacing: 8) {
        AMMMonoLabel(text: "What changed", color: AMMColor.orange)
        Text(card.whatChanged)
          .font(.system(size: 15))
          .foregroundStyle(AMMColor.ink)
          .lineLimit(3)
      }
      .padding(.vertical, 14)

      VStack(alignment: .leading, spacing: 9) {
        HStack {
          AMMMonoLabel(text: card.lifecycle == nil ? "The thesis" : "Active thesis")
          Spacer()
          if let lifecycle = card.lifecycle {
            Text(lifecycle.status.uppercased())
              .font(.system(size: 9, weight: .bold, design: .monospaced))
              .foregroundStyle(AMMColor.orange)
          }
        }
        Text(card.previewThesis)
          .font(.system(size: 25, weight: .black, design: .serif))
          .foregroundStyle(AMMColor.ink)
          .lineLimit(4)
          .minimumScaleFactor(0.82)
      }
      .padding(15)
      .background(AMMColor.paper.opacity(0.62))
      .overlay(alignment: .leading) {
        Rectangle().fill(AMMColor.orange).frame(width: 4)
      }

      if let signal = card.signal {
        VStack(alignment: .leading, spacing: 9) {
          HStack {
            AMMMonoLabel(text: "Current directional read")
            Spacer()
            Text("\(card.votes.support)/5")
              .font(.system(size: 11, weight: .bold, design: .monospaced))
              .foregroundStyle(AMMColor.orange)
          }
          Text(signal.label)
            .font(.system(size: 26, weight: .black, design: .serif))
            .foregroundStyle(signal.fivePointScore < 0 ? AMMColor.orange : signal.fivePointScore > 0 ? AMMColor.cobalt : AMMColor.ink)
          DirectionalScale(score: signal.fivePointScore, compact: true)
          if let movement = card.movement {
            ThesisMovementView(movement: movement, compact: true)
              .padding(.top, 4)
          }
        }
        .padding(.vertical, 16)
      }

      Divider().overlay(AMMColor.rule)
      VStack(alignment: .leading, spacing: 8) {
        AMMMonoLabel(text: "Why it matters")
        Text(card.whyItMatters)
          .font(.system(size: 15))
          .foregroundStyle(AMMColor.ink)
          .lineLimit(4)
        VoteTriangles(votes: card.votes)
      }
      .padding(.vertical, 14)

      Spacer(minLength: 8)
      HStack {
        Text("Open the company file")
          .font(.system(size: 15, weight: .bold, design: .rounded))
        Spacer()
        Image(systemName: "arrow.right")
      }
      .foregroundStyle(AMMColor.cobalt)
      .accessibilityHint("Opens the full research cards and dated sources")
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .ammCardShadow(depth: 7)
    .padding(.horizontal, 5)
    .padding(.bottom, 9)
  }
}

struct LoadingDeskView: View {
  var body: some View {
    VStack(spacing: 18) {
      TriangleActivityView(size: 66)
      AMMMonoLabel(text: "Opening your desk")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct ErrorStateView: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    VStack(spacing: 18) {
      AMMAvatarMark().frame(width: 58, height: 58)
      Text(message)
        .font(.system(size: 17, weight: .semibold))
        .multilineTextAlignment(.center)
      Button("Try again", action: retry)
        .buttonStyle(AMMPrimaryButtonStyle())
        .frame(maxWidth: 260)
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct EmptyDeskCard: View {
  var body: some View {
    VStack(spacing: 16) {
      AMMAvatarMark().frame(width: 54, height: 54)
      Text("Your company files are being prepared.")
        .font(.system(size: 18, weight: .bold, design: .rounded))
      Text("AMM is collecting verified price history, filings and dated evidence. Pull down to check again.")
        .font(.system(size: 14))
        .foregroundStyle(AMMColor.muted)
        .multilineTextAlignment(.center)
    }
    .padding(28)
    .ammCardShadow()
  }
}

private struct SavedDeskBanner: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "checkmark.shield.fill")
        .foregroundStyle(AMMColor.lime)
      Text(message)
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
      Spacer(minLength: 8)
      Button("Retry", action: retry)
        .font(.system(size: 11, weight: .black, design: .monospaced))
        .foregroundStyle(AMMColor.lime)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
    .background(AMMColor.ink)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

struct TriangleActivityView: View {
  var size: CGFloat = 48
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var rotation = Angle.zero

  var body: some View {
    ZStack {
      BrandTriangle()
        .trim(from: 0.02, to: 0.72)
        .stroke(
          AngularGradient(colors: [AMMColor.orange.opacity(0.1), AMMColor.orange], center: .center),
          style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round)
        )
        .rotationEffect(.degrees(12))
      BrandTriangle()
        .stroke(AMMColor.orange.opacity(0.15), lineWidth: 1)
        .rotationEffect(.degrees(12))
    }
    .frame(width: size, height: size)
    .rotationEffect(rotation)
    .task {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
        rotation = .degrees(360)
      }
    }
    .accessibilityLabel("Loading")
  }
}
