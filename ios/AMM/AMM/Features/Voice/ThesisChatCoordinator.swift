import Foundation
import Observation

@MainActor
@Observable
final class ThesisChatCoordinator {
  enum Phase: Equatable {
    case idle
    case opening
    case retrieving
    case verifying
    case finalizing
    case complete
    case quota(String)
    case failed(String)
  }

  struct Message: Codable, Identifiable, Equatable {
    enum Role: String, Codable {
      case member
      case desk
    }

    let id: UUID
    let role: Role
    let text: String
    let createdAt: Date

    init(
      id: UUID = UUID(),
      role: Role,
      text: String,
      createdAt: Date = Date()
    ) {
      self.id = id
      self.role = role
      self.text = text
      self.createdAt = createdAt
    }
  }

  private struct PersistedState: Codable {
    let sessionId: String?
    let messages: [Message]
  }

  let ticker: String
  var draft = ""
  private(set) var phase: Phase = .idle
  private(set) var messages: [Message] = []
  private(set) var progressLines: [String] = []
  private(set) var usedQuestions: Int?
  private(set) var questionCap: Int?

  private let api: AMMAPIClient
  private let storage: UserDefaults
  private var sessionId: String?
  private var requestTask: Task<Void, Never>?
  private var pendingVerifiedAnswer = ""
  private var didCommitPendingAnswer = false
  private var terminalEventReceived = false

  init(
    ticker: String,
    api: AMMAPIClient = AMMAPIClient(),
    storage: UserDefaults = .standard
  ) {
    self.ticker = ticker.uppercased()
    self.api = api
    self.storage = storage
    restore()
  }

  var isWorking: Bool {
    switch phase {
    case .opening, .retrieving, .verifying, .finalizing:
      true
    default:
      false
    }
  }

  var canCancel: Bool {
    switch phase {
    case .opening, .retrieving, .verifying:
      true
    default:
      false
    }
  }

  var statusTitle: String {
    switch phase {
    case .idle:
      "Ask the company file"
    case .opening:
      "Opening the file"
    case .retrieving:
      "Matching dated evidence"
    case .verifying:
      "Verifying every claim"
    case .finalizing:
      "Verified — saving the receipt"
    case .complete:
      "Verified answer"
    case .quota:
      "Question allowance used"
    case .failed:
      "No answer released"
    }
  }

  var statusDetail: String? {
    switch phase {
    case .quota(let message), .failed(let message):
      message
    default:
      progressLines.last
    }
  }

  func send(_ proposedQuestion: String? = nil) {
    let question = (proposedQuestion ?? draft)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .prefix(4_000)
    guard !question.isEmpty, !isWorking else { return }

    startRequest(question: String(question), appendMemberMessage: true)
  }

  func retryLastQuestion() {
    guard
      !isWorking,
      let question = messages.last(where: { $0.role == .member })?.text
    else { return }
    startRequest(question: question, appendMemberMessage: false)
  }

  func stop() {
    guard canCancel else { return }
    requestTask?.cancel()
    requestTask = nil
    phase = .idle
    progressLines = []
  }

  func newSession() {
    requestTask?.cancel()
    requestTask = nil
    sessionId = nil
    messages = []
    progressLines = []
    draft = ""
    phase = .idle
    pendingVerifiedAnswer = ""
    didCommitPendingAnswer = false
    terminalEventReceived = false
    storage.removeObject(forKey: storageKey)
  }

  private func perform(question: String) async {
    do {
      try await api.streamSitting(
        body: SittingRequest(
          ticker: ticker,
          question: question,
          sessionId: sessionId
        )
      ) { [weak self] event in
        self?.handle(event)
      }

      if !terminalEventReceived {
        if !pendingVerifiedAnswer.isEmpty {
          completeWithoutSessionReceipt()
        } else if !Task.isCancelled {
          phase = .failed("The connection ended before a verified answer was released. Try again.")
        }
      }
    } catch is CancellationError {
      if pendingVerifiedAnswer.isEmpty {
        phase = .idle
      } else {
        completeWithoutSessionReceipt()
      }
    } catch {
      if pendingVerifiedAnswer.isEmpty {
        phase = .failed(AMMAPIError.message(for: error))
      } else {
        completeWithoutSessionReceipt()
      }
    }
    requestTask = nil
  }

  private func handle(_ event: SittingStreamEvent) {
    switch event {
    case .progress(let line):
      appendProgress(line)
      let lower = line.lowercased()
      if lower.contains("verif") || lower.contains("source check") {
        phase = .verifying
      } else if lower.contains("match") || lower.contains("reading") || lower.contains("checking") {
        phase = .retrieving
      } else {
        phase = .opening
      }

    case .verifiedAnswer(let answer):
      // The server emits this event only after the deterministic source gate.
      pendingVerifiedAnswer = answer
      commitVerifiedAnswerIfNeeded(answer)
      progressLines = ["Every released claim passed the dated-source gate."]
      phase = .finalizing

    case .completed(let completion):
      terminalEventReceived = true
      sessionId = completion.sessionId
      usedQuestions = completion.used
      questionCap = completion.cap
      pendingVerifiedAnswer = completion.answer
      commitVerifiedAnswerIfNeeded(completion.answer)
      progressLines = []
      phase = .complete
      persist()

    case .quota(let used, let cap, let offer):
      terminalEventReceived = true
      usedQuestions = used
      questionCap = cap
      let meter = cap > 0 ? "\(used) of \(cap) research questions used." : "The research-question allowance is empty."
      phase = .quota([meter, offer].compactMap { $0 }.joined(separator: " "))

    case .failed(let message):
      terminalEventReceived = true
      if pendingVerifiedAnswer.isEmpty {
        phase = .failed(message)
      } else {
        completeWithoutSessionReceipt()
      }
    }
  }

  private func appendProgress(_ line: String) {
    guard progressLines.last != line else { return }
    progressLines.append(line)
    if progressLines.count > 4 {
      progressLines.removeFirst(progressLines.count - 4)
    }
  }

  private func startRequest(question: String, appendMemberMessage: Bool) {
    draft = ""
    requestTask?.cancel()
    if appendMemberMessage {
      messages.append(Message(role: .member, text: question))
      trimHistory()
      persist()
    }

    phase = .opening
    progressLines = ["Opening \(ticker)’s selected company file…"]
    pendingVerifiedAnswer = ""
    didCommitPendingAnswer = false
    terminalEventReceived = false

    requestTask = Task { [weak self] in
      await self?.perform(question: question)
    }
  }

  private func commitVerifiedAnswerIfNeeded(_ answer: String) {
    guard !didCommitPendingAnswer else { return }
    didCommitPendingAnswer = true
    messages.append(Message(role: .desk, text: answer))
    trimHistory()
    persist()
  }

  private func completeWithoutSessionReceipt() {
    commitVerifiedAnswerIfNeeded(pendingVerifiedAnswer)
    sessionId = nil
    progressLines = [
      "The answer passed the dated-source gate, but its continuing-session receipt was not saved. The next question will open a fresh file thread."
    ]
    phase = .complete
    persist()
  }

  private func trimHistory() {
    if messages.count > 12 {
      messages.removeFirst(messages.count - 12)
    }
  }

  private var storageKey: String {
    "com.evolo.amm.chat.v1.\(ticker)"
  }

  private func restore() {
    guard
      let data = storage.data(forKey: storageKey),
      let state = try? JSONDecoder().decode(PersistedState.self, from: data)
    else { return }
    sessionId = state.sessionId
    messages = Array(state.messages.suffix(12))
  }

  private func persist() {
    let state = PersistedState(
      sessionId: sessionId,
      messages: Array(messages.suffix(12))
    )
    guard let data = try? JSONEncoder().encode(state) else { return }
    storage.set(data, forKey: storageKey)
  }
}
