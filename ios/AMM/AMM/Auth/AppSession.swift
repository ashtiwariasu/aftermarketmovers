import ClerkKit
import Foundation
import Observation

@MainActor
@Observable
final class AppSession {
  enum LoadState: Equatable {
    case idle
    case loading
    case needsDesk
    case ready
    case failed(String)
  }

  private(set) var desk: DeskEnvelope?
  private(set) var state: LoadState = .idle
  private(set) var isShowingSavedDesk = false
  private(set) var syncMessage: String?
  private(set) var mutationError: String?
  private(set) var isSavingDesk = false
  var selectedTicker: String?
  var selectedCardIndex = 0

  private let api = AMMAPIClient()
  private let snapshots = DeskSnapshotStore()
  private var currentUserID: String?
  private var activeLoadID: UUID?

  var cards: [DeskCard] {
    desk?.cards ?? []
  }

  var selectedCard: DeskCard? {
    if let selectedTicker,
       let card = cards.first(where: { $0.ticker == selectedTicker }) {
      return card
    }
    guard cards.indices.contains(selectedCardIndex) else { return cards.first }
    return cards[selectedCardIndex]
  }

  var companyLimit: Int {
    desk?.desk.tier.lowercased() == "ultra" ? 30 : 3
  }

  func loadDesk(userID: String) async {
    let loadID = UUID()
    activeLoadID = loadID
    currentUserID = userID
    mutationError = nil

    if desk == nil, let saved = try? await snapshots.load(userID: userID) {
      guard isCurrent(loadID, userID: userID) else { return }
      install(saved)
      isShowingSavedDesk = true
      syncMessage = "Showing your last verified Desk while AMM checks for updates."
    }

    if desk == nil {
      state = .loading
    }

    do {
      let envelope: DeskEnvelope = try await api.get("/api/mobile/v1/desk")
      guard isCurrent(loadID, userID: userID) else { return }
      install(envelope)
      try? await snapshots.save(envelope, userID: userID)
      guard isCurrent(loadID, userID: userID) else { return }
      isShowingSavedDesk = false
      syncMessage = nil
      state = .ready
    } catch is CancellationError {
      guard isCurrent(loadID, userID: userID) else { return }
      state = desk == nil ? .idle : .ready
    } catch let error as AMMAPIError {
      guard isCurrent(loadID, userID: userID) else { return }
      if case .rejected(let status, _, _) = error, status == 404 {
        desk = nil
        selectedTicker = nil
        selectedCardIndex = 0
        try? await snapshots.remove(userID: userID)
        isShowingSavedDesk = false
        syncMessage = nil
        state = .needsDesk
      } else if desk != nil {
        isShowingSavedDesk = true
        syncMessage = "Offline · showing your last verified Desk."
        state = .ready
      } else {
        state = .failed(AMMAPIError.message(for: error))
      }
    } catch {
      guard isCurrent(loadID, userID: userID) else { return }
      if desk != nil {
        isShowingSavedDesk = true
        syncMessage = "Offline · showing your last verified Desk."
        state = .ready
      } else {
        state = .failed(AMMAPIError.message(for: error))
      }
    }
  }

  func refreshDesk() async {
    guard let currentUserID else { return }
    await loadDesk(userID: currentUserID)
  }

  @discardableResult
  func saveTickers(_ tickers: [String]) async -> Bool {
    guard let currentUserID else {
      mutationError = AMMAPIError.signedOut.errorDescription
      return false
    }

    let normalized = Array(
      Set(tickers.map { $0.uppercased().trimmingCharacters(in: .whitespacesAndNewlines) })
    ).sorted()
    guard !normalized.isEmpty else {
      mutationError = "Choose at least one company."
      return false
    }

    isSavingDesk = true
    mutationError = nil
    defer { isSavingDesk = false }
    do {
      let request = DeskMutationRequest(
        tickers: normalized,
        noteTime: desk?.desk.noteTime ?? "07:00",
        tz: desk?.desk.timeZone ?? TimeZone.current.identifier
      )
      let _: DeskMutationResponse = try await api.post("/api/desk", body: request)
      await loadDesk(userID: currentUserID)
      return desk != nil && state == .ready
    } catch is CancellationError {
      return false
    } catch {
      mutationError = AMMAPIError.message(for: error)
      return false
    }
  }

  func clearMutationError() {
    mutationError = nil
  }

  func select(_ card: DeskCard) {
    selectedTicker = card.ticker
    if let index = cards.firstIndex(where: { $0.ticker == card.ticker }) {
      selectedCardIndex = index
    }
  }

  func reset() {
    desk = nil
    currentUserID = nil
    activeLoadID = nil
    selectedTicker = nil
    selectedCardIndex = 0
    isShowingSavedDesk = false
    syncMessage = nil
    mutationError = nil
    isSavingDesk = false
    state = .idle
  }

  private func install(_ envelope: DeskEnvelope) {
    desk = envelope
    if let selectedTicker,
       let index = envelope.cards.firstIndex(where: { $0.ticker == selectedTicker }) {
      selectedCardIndex = index
    } else {
      selectedCardIndex = 0
      selectedTicker = envelope.cards.first?.ticker
    }
  }

  private func isCurrent(_ loadID: UUID, userID: String) -> Bool {
    activeLoadID == loadID && currentUserID == userID
  }
}
