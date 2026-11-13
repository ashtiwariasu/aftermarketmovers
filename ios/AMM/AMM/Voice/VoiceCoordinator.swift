import AVFoundation
import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class VoiceCoordinator {
  enum Phase: Equatable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case retrieving
    case verifying
    case speaking
    case paused
    case interrupted
    case ended
    case failed(String)
  }

  struct VerifiedFact: Identifiable, Equatable {
    let id: String
    let label: String
    let url: URL?
  }

  let ticker: String
  private(set) var phase: Phase = .idle
  private(set) var remainingSeconds: Int
  private(set) var quotaSeconds: Int
  private(set) var verifiedFacts: [VerifiedFact] = []
  private(set) var lastAnswer = ""
  private(set) var lastQuestion = ""
  private(set) var isMicrophoneMuted = false
  private(set) var allowanceReason: String?
  private(set) var progressReceipt: String?

  private let api = AMMAPIClient()
  private var realtime: RealtimeWebRTCClient?
  private var token: VoiceTokenResponse?
  private var meterTask: Task<Void, Never>?
  private var toolTask: Task<Void, Never>?
  private var handledCalls = Set<String>()
  private var initialQuestionSent = false
  private var isEnding = false
  private var audioObserverTokens: [NSObjectProtocol] = []

  init(ticker: String, allowance: VoiceAllowance?) {
    self.ticker = ticker.uppercased()
    remainingSeconds = allowance?.remainingSeconds ?? 0
    quotaSeconds = allowance?.quotaSeconds ?? 0
    allowanceReason = allowance?.reason
  }

  var isActive: Bool {
    switch phase {
    case .connecting, .listening, .retrieving, .verifying, .speaking, .paused, .interrupted:
      true
    default:
      false
    }
  }

  var statusTitle: String {
    switch phase {
    case .idle where needsUpgrade:
      "Unlock live thesis voice"
    case .idle where dailyAllowanceUsed:
      "Today’s voice time is complete"
    case .idle where activeElsewhere:
      "Voice is active on another device"
    case .idle:
      "Talk to the \(ticker) thesis"
    case .requestingPermission: "Opening the microphone"
    case .connecting: "Opening the company file"
    case .listening: "Listening"
    case .retrieving: "Retrieving the relevant evidence"
    case .verifying: "Checking dates and sources"
    case .speaking: "AMM is answering"
    case .paused: "Microphone paused"
    case .interrupted: "Voice paused by another audio session"
    case .ended: "Conversation ended"
    case .failed: "Voice could not start"
    }
  }

  var statusDetail: String {
    switch phase {
    case .idle where needsUpgrade:
      "AMM Pro includes 15 minutes a day; Ultra includes 60."
    case .idle where dailyAllowanceUsed:
      "Your allowance resets with the next AMM day."
    case .idle where activeElsewhere:
      "End the other conversation, then refresh this company file."
    case .idle:
      "Ask about the thesis, evidence, risk, disagreement, or what would change the read."
    case .requestingPermission:
      "Audio stays live only for this conversation."
    case .connecting:
      "Securing a source-bound Realtime session."
    case .listening:
      "Ask naturally. Interrupt at any time."
    case .retrieving:
      progressReceipt ?? "Matching your question to the selected company file."
    case .verifying:
      progressReceipt ?? "Only verified facts are released to the conversation."
    case .speaking:
      "Dated sources appear here as the answer is released."
    case .paused:
      "Tap the microphone to continue."
    case .interrupted:
      "AMM will resume when the interruption ends."
    case .ended:
      "The audio connection and server lease are closed."
    case .failed(let message):
      message
    }
  }

  var canStart: Bool {
    !needsUpgrade && !dailyAllowanceUsed && !activeElsewhere
  }

  var needsUpgrade: Bool {
    allowanceReason == "not_in_plan"
  }

  var dailyAllowanceUsed: Bool {
    allowanceReason == "quota_exhausted"
      || (quotaSeconds > 0 && remainingSeconds <= 0)
  }

  var activeElsewhere: Bool {
    allowanceReason == "already_active"
  }

  var clockText: String {
    let value = max(0, remainingSeconds)
    return "\(value / 60):\(String(format: "%02d", value % 60))"
  }

  func start() async {
    guard !isActive, canStart else { return }
    phase = .requestingPermission
    do {
      guard await requestMicrophonePermission() else {
        phase = .failed(
          "Microphone access is required. Enable it in Settings → Privacy & Security → Microphone."
        )
        return
      }
      installAudioObservers()
      try configureAudioSession()
      phase = .connecting
      verifiedFacts = []
      lastAnswer = ""
      lastQuestion = ""
      progressReceipt = nil
      handledCalls.removeAll()
      initialQuestionSent = false

      let token: VoiceTokenResponse = try await api.post(
        "/api/mobile/v1/voice/token",
        body: VoiceTokenRequest(ticker: ticker)
      )
      self.token = token
      remainingSeconds = token.remainingSeconds
      quotaSeconds = token.quotaSeconds
      allowanceReason = nil

      guard
        let endpoint = URL(string: token.webRtcEndpoint),
        AMMConfiguration.isTrustedRealtimeEndpoint(endpoint)
      else {
        throw VoiceFailure.invalidEndpoint
      }
      let realtime = RealtimeWebRTCClient { [weak self] event in
        self?.handle(event)
      }
      self.realtime = realtime
      try await realtime.connect(endpoint: endpoint, clientSecret: token.clientSecret)
      startMeter()
    } catch {
      if case AMMAPIError.rejected(_, _, let code) = error {
        switch code {
        case "voice_upgrade_required":
          allowanceReason = "not_in_plan"
        case "quota_exhausted":
          allowanceReason = "quota_exhausted"
        case "already_active":
          allowanceReason = "already_active"
        default:
          break
        }
      }
      await finishLease()
      realtime?.disconnect()
      realtime = nil
      removeAudioObservers()
      deactivateAudioSession()
      phase = .failed(voiceErrorMessage(error))
    }
  }

  func toggleMicrophone() {
    guard isActive else { return }
    isMicrophoneMuted.toggle()
    realtime?.setMicrophoneEnabled(!isMicrophoneMuted)
    if isMicrophoneMuted {
      phase = .paused
    } else {
      phase = .listening
    }
  }

  func finish() async {
    guard !isEnding else { return }
    isEnding = true
    meterTask?.cancel()
    meterTask = nil
    toolTask?.cancel()
    toolTask = nil
    realtime?.disconnect()
    realtime = nil
    await finishLease()
    removeAudioObservers()
    deactivateAudioSession()
    token = nil
    isMicrophoneMuted = false
    phase = .ended
    isEnding = false
  }

  private func handle(_ event: RealtimeClientEvent) {
    switch event {
    case .ready:
      phase = .listening
      if !initialQuestionSent {
        initialQuestionSent = true
        realtime?.sendInitialQuestion(for: ticker)
      }
    case .listening:
      if !isMicrophoneMuted { phase = .listening }
    case .speaking:
      phase = .speaking
    case .responseFinished:
      if phase == .speaking { phase = .listening }
    case .functionCall(let callID, let name, let arguments):
      guard name == "answer_from_company_file", !handledCalls.contains(callID) else { return }
      handledCalls.insert(callID)
      guard toolTask == nil else {
        realtime?.sendFunctionOutput(
          callID: callID,
          spokenAnswer:
            "A dated-source check is already running. Please wait for that answer, then ask the next question."
        )
        return
      }
      toolTask = Task { [weak self] in
        await self?.runCompanyFileTool(callID: callID, arguments: arguments)
      }
    case .closed:
      guard !isEnding else { return }
      Task { await finish() }
    case .failed(let message):
      phase = .failed(message)
      Task { await finishAfterFailure(message) }
    }
  }

  private func runCompanyFileTool(callID: String, arguments: String) async {
    defer { toolTask = nil }
    guard
      let token,
      let data = arguments.data(using: .utf8),
      let payload = try? JSONDecoder().decode(RealtimeFunctionArguments.self, from: data),
      !payload.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      realtime?.sendFunctionOutput(
        callID: callID,
        spokenAnswer: "AMM could not understand that question. Please ask it again."
      )
      return
    }

    lastQuestion = payload.question
    verifiedFacts = []
    progressReceipt = "Matching your question to the selected company file."
    phase = .retrieving
    do {
      var completedResult: VoiceToolResponse?
      var streamedFailure: String?
      try await api.streamVoiceTool(
        path: token.toolPath,
        body: VoiceToolRequest(
          sessionId: token.voiceSessionId,
          question: payload.question
        )
      ) { [weak self] event in
        guard let self else { return }
        switch event {
        case .progress(let line):
          self.progressReceipt = line
          let normalized = line.lowercased()
          if normalized.contains("verif")
            || normalized.contains("source check")
            || normalized.contains("dated source")
          {
            self.phase = .verifying
          } else {
            self.phase = .retrieving
          }
        case .completed(let result):
          completedResult = result
        case .failed(let message):
          streamedFailure = message
        }
      }
      try Task.checkCancellation()
      if let streamedFailure {
        throw VoiceToolFailure.refused(streamedFailure)
      }
      guard let result = completedResult else {
        throw VoiceToolFailure.refused(
          "The connection ended before a verified answer was released."
        )
      }

      phase = .verifying
      progressReceipt = "Every released claim passed the dated-source gate."
      // Show the same concise, source-gated language the member hears. The
      // longer markdown answer remains available in the underlying file.
      lastAnswer = result.spokenAnswer
      if let allowance = result.allowance {
        remainingSeconds = allowance.remainingSeconds
        quotaSeconds = allowance.quotaSeconds
        allowanceReason = allowance.reason
      }

      // The server has already validated the complete answer. Citations are
      // revealed one at a time only after that gate has passed.
      for citation in result.citations ?? [] {
        guard !Task.isCancelled else { return }
        verifiedFacts.append(
          VerifiedFact(
            id: citation.id,
            label: citation.label,
            url: citation.href.flatMap(URL.init(string:))
          )
        )
        try? await Task.sleep(for: .milliseconds(120))
      }
      realtime?.sendFunctionOutput(
        callID: callID,
        spokenAnswer: result.spokenAnswer
      )
      phase = .speaking
      progressReceipt = nil
    } catch is CancellationError {
      progressReceipt = nil
      return
    } catch {
      let safeAnswer =
        "AMM could not release a complete answer from the admitted dated sources. "
        + "Try a narrower question about the thesis, evidence, risk, or what would change the read."
      realtime?.sendFunctionOutput(callID: callID, spokenAnswer: safeAnswer)
      if case AMMAPIError.rejected(let status, _, _) = error, status == 429 {
        if case AMMAPIError.rejected(_, _, let code) = error {
          allowanceReason = code
        }
        await finishAfterFailure(AMMAPIError.message(for: error))
      } else {
        progressReceipt = nil
        phase = .speaking
      }
    }
  }

  private func startMeter() {
    meterTask?.cancel()
    meterTask = Task { [weak self] in
      guard let self else { return }
      var heartbeatTick = 0
      while !Task.isCancelled, self.isActive {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, self.isActive else { break }
        self.remainingSeconds = max(0, self.remainingSeconds - 1)
        heartbeatTick += 1
        if self.remainingSeconds == 0 {
          self.allowanceReason = "quota_exhausted"
          await self.finish()
          break
        }
        if heartbeatTick >= 10 {
          heartbeatTick = 0
          await self.sendHeartbeat()
        }
      }
    }
  }

  private func sendHeartbeat() async {
    guard let token else { return }
    do {
      let response: VoiceHeartbeatResponse = try await api.post(
        token.heartbeatPath,
        body: VoiceHeartbeatRequest(
          sessionId: token.voiceSessionId,
          finish: false
        )
      )
      remainingSeconds = response.allowance.remainingSeconds
      quotaSeconds = response.allowance.quotaSeconds
      allowanceReason = response.allowance.reason
      if !response.allowance.allowed {
        await finish()
      }
    } catch {
      phase = .failed("The metered voice session ended. Tap to reconnect.")
      await finishAfterFailure("The metered voice session ended. Tap to reconnect.")
    }
  }

  private func finishLease() async {
    guard let token else { return }
    let _: VoiceHeartbeatResponse? = try? await api.post(
      token.heartbeatPath,
      body: VoiceHeartbeatRequest(
        sessionId: token.voiceSessionId,
        finish: true
      )
    )
  }

  private func finishAfterFailure(_ message: String) async {
    meterTask?.cancel()
    meterTask = nil
    toolTask?.cancel()
    toolTask = nil
    realtime?.disconnect()
    realtime = nil
    await finishLease()
    removeAudioObservers()
    deactivateAudioSession()
    token = nil
    isMicrophoneMuted = false
    phase = .failed(message)
  }

  private func requestMicrophonePermission() async -> Bool {
    await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { granted in
        continuation.resume(returning: granted)
      }
    }
  }

  private func configureAudioSession() throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
  }

  private func installAudioObservers() {
    guard audioObserverTokens.isEmpty else { return }
    let center = NotificationCenter.default
    let interruption = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      let typeValue =
        notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let optionValue =
        notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
      Task { @MainActor [weak self] in
        self?.handleAudioInterruption(typeValue: typeValue, optionValue: optionValue)
      }
    }
    let mediaReset = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.recoverAudioAfterMediaReset()
      }
    }
    audioObserverTokens = [interruption, mediaReset]
  }

  private func removeAudioObservers() {
    let center = NotificationCenter.default
    for token in audioObserverTokens {
      center.removeObserver(token)
    }
    audioObserverTokens.removeAll()
  }

  private func handleAudioInterruption(typeValue: UInt?, optionValue: UInt?) {
    guard
      let typeValue,
      let type = AVAudioSession.InterruptionType(rawValue: typeValue)
    else { return }
    switch type {
    case .began:
      guard isActive else { return }
      realtime?.setMicrophoneEnabled(false)
      phase = .interrupted
    case .ended:
      let options = AVAudioSession.InterruptionOptions(rawValue: optionValue ?? 0)
      guard options.contains(.shouldResume), realtime != nil else {
        isMicrophoneMuted = true
        phase = .paused
        return
      }
      do {
        try configureAudioSession()
        realtime?.setMicrophoneEnabled(true)
        isMicrophoneMuted = false
        phase = .listening
      } catch {
        phase = .failed("Audio could not resume. End this conversation and reconnect.")
      }
    @unknown default:
      break
    }
  }

  private func recoverAudioAfterMediaReset() {
    guard realtime != nil else { return }
    do {
      try configureAudioSession()
      realtime?.setMicrophoneEnabled(!isMicrophoneMuted)
      phase = isMicrophoneMuted ? .paused : .listening
    } catch {
      phase = .failed("Audio services restarted. End this conversation and reconnect.")
    }
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
  }

  private func voiceErrorMessage(_ error: Error) -> String {
    if let apiError = error as? AMMAPIError {
      return apiError.errorDescription ?? "Live voice could not start."
    }
    if let failure = error as? VoiceFailure {
      return failure.errorDescription ?? "Live voice could not start."
    }
    if let localized = error as? LocalizedError, let message = localized.errorDescription {
      return message
    }
    return "Live voice could not start. Check your connection and try again."
  }
}

private enum VoiceFailure: LocalizedError {
  case invalidEndpoint

  var errorDescription: String? {
    "AMM received an invalid secure voice endpoint."
  }
}

private enum VoiceToolFailure: LocalizedError {
  case refused(String)

  var errorDescription: String? {
    switch self {
    case .refused(let message):
      message
    }
  }
}
