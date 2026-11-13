import SwiftUI

enum DeskSetupMode: Equatable {
  case onboarding
  case manage
}

struct DeskSetupView: View {
  @Environment(AppSession.self) private var session
  @FocusState private var tickerFieldFocused: Bool

  let mode: DeskSetupMode
  let onSaved: () -> Void

  @State private var tickerDraft = ""
  @State private var selected: [String]

  private let popularTickers = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD",
  ]

  init(
    mode: DeskSetupMode,
    initialTickers: [String] = [],
    onSaved: @escaping () -> Void = {}
  ) {
    self.mode = mode
    self.onSaved = onSaved
    _selected = State(initialValue: initialTickers)
  }

  var body: some View {
    @Bindable var session = session

    ZStack {
      AMMColor.paper.ignoresSafeArea()
      PaperNoise()

      ScrollView {
        VStack(alignment: .leading, spacing: 26) {
          header
          intro
          selectionCard
          coverageCard

          if let error = session.mutationError {
            Text(error)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(AMMColor.orange)
              .padding(16)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(AMMColor.orange.opacity(0.07))
              .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
              .accessibilityLabel("Could not save companies. \(error)")
          }

          Button {
            tickerFieldFocused = false
            Task {
              if await session.saveTickers(selected) {
                onSaved()
              }
            }
          } label: {
            HStack(spacing: 10) {
              if session.isSavingDesk {
                ProgressView().tint(.white)
              }
              Text(session.isSavingDesk ? "Building your Desk…" : saveLabel)
              Image(systemName: "arrow.right")
            }
          }
          .buttonStyle(AMMPrimaryButtonStyle())
          .disabled(selected.isEmpty || session.isSavingDesk)
          .opacity(selected.isEmpty ? 0.5 : 1)

          if mode == .onboarding {
            Text("Your first company files begin building after this step. AMM will keep the same verified Desk across web and iPhone.")
              .font(.system(size: 12))
              .foregroundStyle(AMMColor.muted)
              .multilineTextAlignment(.center)
              .frame(maxWidth: .infinity)
          }
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 42)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .onChange(of: tickerDraft) { _, value in
      tickerDraft = sanitized(value)
    }
    .onAppear {
      session.clearMutationError()
    }
  }

  private var header: some View {
    HStack {
      AMMWordmark(size: 27)
      Spacer()
      if mode == .manage {
        Button("Done", action: onSaved)
          .font(.system(size: 15, weight: .bold, design: .rounded))
          .foregroundStyle(AMMColor.ink)
      }
    }
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: 12) {
      AMMMonoLabel(
        text: mode == .onboarding ? "Build your AMM Desk" : "Companies on your Desk",
        color: AMMColor.orange
      )
      Text(mode == .onboarding ? "Which companies should AMM know cold?" : "Keep the companies that matter.")
        .font(.system(size: 38, weight: .black, design: .rounded))
        .foregroundStyle(AMMColor.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text("Choose up to \(selectionLimit). AMM verifies market data and primary filing coverage before a company can use a slot.")
        .font(.system(size: 16))
        .foregroundStyle(AMMColor.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var selectionCard: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        AMMMonoLabel(text: "Selected")
        Spacer()
        Text("\(selected.count)/\(selectionLimit)")
          .font(.system(size: 12, weight: .bold, design: .monospaced))
          .foregroundStyle(selected.count >= selectionLimit ? AMMColor.orange : AMMColor.muted)
      }

      if !selected.isEmpty {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 86), spacing: 8)], spacing: 8) {
          ForEach(selected, id: \.self) { ticker in
            Button {
              selected.removeAll { $0 == ticker }
              session.clearMutationError()
            } label: {
              HStack(spacing: 7) {
                Text(ticker)
                Image(systemName: "xmark")
                  .font(.system(size: 9, weight: .black))
              }
              .font(.system(size: 13, weight: .black, design: .monospaced))
              .foregroundStyle(AMMColor.ink)
              .padding(.horizontal, 12)
              .padding(.vertical, 10)
              .frame(maxWidth: .infinity)
              .background(AMMColor.lime)
              .clipShape(Capsule())
            }
            .accessibilityLabel("Remove \(ticker)")
          }
        }
      }

      HStack(spacing: 10) {
        TextField("Ticker — e.g. NVDA", text: $tickerDraft)
          .textInputAutocapitalization(.characters)
          .autocorrectionDisabled()
          .keyboardType(.asciiCapable)
          .font(.system(size: 17, weight: .bold, design: .monospaced))
          .focused($tickerFieldFocused)
          .submitLabel(.done)
          .onSubmit(addDraft)
          .padding(.horizontal, 16)
          .frame(height: 54)
          .background(AMMColor.paper)
          .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(AMMColor.rule, lineWidth: 1.5)
          }

        Button(action: addDraft) {
          Image(systemName: "plus")
            .font(.system(size: 18, weight: .black))
            .foregroundStyle(.white)
            .frame(width: 54, height: 54)
            .background(AMMColor.ink)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .disabled(!canAddDraft)
        .opacity(canAddDraft ? 1 : 0.35)
        .accessibilityLabel("Add ticker")
      }

      VStack(alignment: .leading, spacing: 10) {
        AMMMonoLabel(text: "Popular company files", color: AMMColor.muted)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
          ForEach(popularTickers, id: \.self) { ticker in
            Button {
              toggle(ticker)
            } label: {
              Text(ticker)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(selected.contains(ticker) ? .white : AMMColor.ink)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(selected.contains(ticker) ? AMMColor.cobalt : AMMColor.paper)
                .clipShape(Capsule())
                .overlay {
                  Capsule().stroke(AMMColor.rule, lineWidth: selected.contains(ticker) ? 0 : 1)
                }
            }
            .disabled(!selected.contains(ticker) && selected.count >= selectionLimit)
          }
        }
      }
    }
    .padding(20)
    .ammCardShadow(depth: 6)
  }

  private var coverageCard: some View {
    HStack(alignment: .top, spacing: 14) {
      AMMAvatarMark().frame(width: 44, height: 44)
      VStack(alignment: .leading, spacing: 5) {
        Text("US-listed companies with complete coverage")
          .font(.system(size: 15, weight: .bold, design: .rounded))
        Text("Price history and primary filings must both pass AMM’s coverage check. An unsupported symbol never consumes a company slot.")
          .font(.system(size: 13))
          .foregroundStyle(AMMColor.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(18)
    .background(AMMColor.card.opacity(0.72))
    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .stroke(AMMColor.rule.opacity(0.5), lineWidth: 1)
    }
  }

  private var selectionLimit: Int {
    max(session.companyLimit, selected.count)
  }

  private var saveLabel: String {
    mode == .onboarding ? "Start my 30-day trial" : "Update my Desk"
  }

  private var canAddDraft: Bool {
    !tickerDraft.isEmpty &&
      !selected.contains(tickerDraft) &&
      selected.count < selectionLimit
  }

  private func addDraft() {
    guard canAddDraft else { return }
    selected.append(tickerDraft)
    selected.sort()
    tickerDraft = ""
    session.clearMutationError()
  }

  private func toggle(_ ticker: String) {
    if selected.contains(ticker) {
      selected.removeAll { $0 == ticker }
    } else if selected.count < selectionLimit {
      selected.append(ticker)
      selected.sort()
    }
    session.clearMutationError()
  }

  private func sanitized(_ value: String) -> String {
    String(
      value
        .uppercased()
        .filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
        .prefix(8)
    )
  }
}
