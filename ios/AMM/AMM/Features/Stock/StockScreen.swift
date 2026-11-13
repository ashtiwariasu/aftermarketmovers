import Observation
import SwiftUI

struct StockScreen: View {
  let ticker: String
  @Environment(\.dismiss) private var dismiss
  @State private var model = StockViewModel()

  var body: some View {
    ZStack {
      AMMColor.paper.ignoresSafeArea()
      PaperNoise()
      content
    }
    .toolbar(.hidden, for: .navigationBar)
    .task(id: ticker) {
      await model.load(ticker: ticker)
    }
  }

  @ViewBuilder
  private var content: some View {
    switch model.state {
    case .loading, .idle:
      LoadingDeskView()
    case .failed(let message):
      ErrorStateView(message: message) {
        Task { await model.load(ticker: ticker) }
      }
    case .ready:
      stockContent
    }
  }

  private var stockContent: some View {
    ScrollView {
      LazyVStack(spacing: 22) {
        header
        if let card = model.heroCard {
          VoiceHeroView(card: card, allowance: model.envelope?.voice)
        }
        runDeck
        sourceLedger
      }
      .padding(.horizontal, 18)
      .padding(.bottom, 44)
    }
    .scrollIndicators(.hidden)
  }

  private var header: some View {
    HStack {
      Button {
        dismiss()
      } label: {
        Image(systemName: "arrow.left")
          .font(.system(size: 17, weight: .bold))
          .frame(width: 42, height: 42)
          .foregroundStyle(AMMColor.ink)
          .background(AMMColor.card, in: Circle())
          .overlay(Circle().stroke(AMMColor.ink, lineWidth: 1.5))
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(model.envelope?.company.ticker ?? ticker)
          .font(.system(size: 30, weight: .black, design: .rounded))
          .foregroundStyle(AMMColor.cobalt)
        Text(model.envelope?.company.name ?? "")
          .font(.system(size: 12))
          .foregroundStyle(AMMColor.muted)
      }
      Spacer()
      if let price = model.envelope?.company.price {
        Text(price, format: .currency(code: "USD"))
          .font(.system(size: 17, weight: .semibold, design: .monospaced))
      }
    }
    .padding(.top, 8)
  }

  private var runDeck: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        AMMMonoLabel(text: "Full research cards", color: AMMColor.orange)
        Spacer()
        Text("\(model.selectedCardIndex + 1)/\(max(1, model.cards.count))")
          .font(.system(size: 12, weight: .semibold, design: .monospaced))
          .foregroundStyle(AMMColor.muted)
      }
      if model.cards.isEmpty {
        Text("No release-validated research card is available yet.")
          .padding(24)
          .ammCardShadow()
      } else {
        TabView(selection: $model.selectedCardIndex) {
          ForEach(Array(model.cards.enumerated()), id: \.element.id) { index, card in
            ResearchCard(card: card, date: model.envelope?.current?.date ?? "")
              .tag(index)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: 510)
      }
    }
  }

  @ViewBuilder
  private var sourceLedger: some View {
    if let sources = model.envelope?.sources, !sources.isEmpty {
      DisclosureGroup("Dated sources (\(sources.count))") {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(sources) { source in
            if let url = URL(string: source.url) {
              Link(destination: url) {
                HStack(alignment: .top, spacing: 10) {
                  Text("\(source.id)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .frame(width: 24, height: 24)
                    .background(AMMColor.cobalt.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                  VStack(alignment: .leading, spacing: 3) {
                    Text(source.title)
                      .font(.system(size: 14, weight: .semibold))
                      .foregroundStyle(AMMColor.ink)
                    Text(
                      [source.sourceType.uppercased(), source.date]
                        .compactMap { $0 }
                        .joined(separator: " · ")
                    )
                      .font(.system(size: 9, weight: .medium, design: .monospaced))
                      .foregroundStyle(AMMColor.muted)
                  }
                  Spacer()
                  Image(systemName: "arrow.up.right")
                    .foregroundStyle(AMMColor.cobalt)
                }
              }
            }
          }
        }
        .padding(.top, 16)
      }
      .font(.system(size: 14, weight: .bold, design: .monospaced))
      .padding(18)
      .ammCardShadow()
    }
  }
}

@MainActor
@Observable
private final class StockViewModel {
  enum State {
    case idle
    case loading
    case ready
    case failed(String)
  }

  private(set) var state: State = .idle
  private(set) var envelope: StockEnvelope?
  var selectedCardIndex = 0
  private let api = AMMAPIClient()

  var cards: [ChairmanCard] {
    envelope?.current?.cards ?? []
  }

  var heroCard: DeskCard? {
    envelope?.deskCard
  }

  func load(ticker: String) async {
    state = .loading
    do {
      let value: StockEnvelope = try await api.get("/api/mobile/v1/stock/\(ticker.lowercased())")
      envelope = value
      selectedCardIndex = 0
      state = .ready
    } catch {
      state = .failed(AMMAPIError.message(for: error))
    }
  }
}

private struct ResearchCard: View {
  let card: ChairmanCard
  let date: String

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        AMMMonoLabel(text: card.label, color: AMMColor.orange)
        Spacer()
        Text(date)
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .foregroundStyle(AMMColor.muted)
      }
      Text(card.title)
        .font(.system(size: 28, weight: .black, design: .serif))
        .foregroundStyle(AMMColor.ink)
        .minimumScaleFactor(0.75)
      Divider().overlay(AMMColor.rule)
      ScrollView {
        Text(markdown(card.markdown))
          .font(.system(size: 16))
          .foregroundStyle(AMMColor.ink)
          .tint(AMMColor.cobalt)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .scrollIndicators(.hidden)
    }
    .padding(21)
    .ammCardShadow(depth: 7)
    .padding(.horizontal, 5)
    .padding(.bottom, 9)
  }

  private func markdown(_ value: String) -> AttributedString {
    (try? AttributedString(
      markdown: value,
      options: .init(interpretedSyntax: .full)
    )) ?? AttributedString(value)
  }
}
