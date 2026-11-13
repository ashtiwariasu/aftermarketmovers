import Foundation
import WebRTC

enum RealtimeClientEvent: Sendable {
  case ready
  case listening
  case speaking
  case responseFinished
  case functionCall(callID: String, name: String, arguments: String)
  case closed
  case failed(String)
}

/// The direct media connection to OpenAI Realtime.
///
/// The standard OpenAI key and the AMM source bundle never enter this class.
/// It receives only a short-lived client secret from the authenticated AMM API.
@MainActor
final class RealtimeWebRTCClient: NSObject {
  typealias EventHandler = @MainActor (RealtimeClientEvent) -> Void

  private let onEvent: EventHandler
  private var factory: RTCPeerConnectionFactory?
  private var peerConnection: RTCPeerConnection?
  private var dataChannel: RTCDataChannel?
  private var localAudioTrack: RTCAudioTrack?
  private var hasReportedReady = false

  init(onEvent: @escaping EventHandler) {
    self.onEvent = onEvent
    super.init()
  }

  func connect(endpoint: URL, clientSecret: String) async throws {
    RTCInitializeSSL()

    let encoderFactory = RTCDefaultVideoEncoderFactory()
    let decoderFactory = RTCDefaultVideoDecoderFactory()
    let factory = RTCPeerConnectionFactory(
      encoderFactory: encoderFactory,
      decoderFactory: decoderFactory
    )
    self.factory = factory

    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.continualGatheringPolicy = .gatherContinually

    let connectionConstraints = RTCMediaConstraints(
      mandatoryConstraints: nil,
      optionalConstraints: [
        "DtlsSrtpKeyAgreement": "true",
      ]
    )
    guard let peerConnection = factory.peerConnection(
      with: configuration,
      constraints: connectionConstraints,
      delegate: self
    ) else {
      throw RealtimeConnectionError.setupFailed
    }
    self.peerConnection = peerConnection

    let audioConstraints = RTCMediaConstraints(
      mandatoryConstraints: nil,
      optionalConstraints: [
        "googEchoCancellation": "true",
        "googNoiseSuppression": "true",
        "googAutoGainControl": "true",
      ]
    )
    let audioSource = factory.audioSource(with: audioConstraints)
    let audioTrack = factory.audioTrack(with: audioSource, trackId: "amm-member-audio")
    localAudioTrack = audioTrack
    peerConnection.add(audioTrack, streamIds: ["amm-live-thesis"])

    let channelConfiguration = RTCDataChannelConfiguration()
    channelConfiguration.isOrdered = true
    guard let dataChannel = peerConnection.dataChannel(
      forLabel: "oai-events",
      configuration: channelConfiguration
    ) else {
      throw RealtimeConnectionError.setupFailed
    }
    dataChannel.delegate = self
    self.dataChannel = dataChannel

    let offerConstraints = RTCMediaConstraints(
      mandatoryConstraints: [
        "OfferToReceiveAudio": "true",
      ],
      optionalConstraints: nil
    )
    let offerSDP = try await createOfferSDP(
      on: peerConnection,
      constraints: offerConstraints
    )
    let offer = RTCSessionDescription(type: .offer, sdp: offerSDP)
    try await setLocalDescription(offer, on: peerConnection)
    let answerSDP = try await exchangeSDP(
      offerSDP,
      endpoint: endpoint,
      clientSecret: clientSecret
    )
    try await setRemoteDescription(
      RTCSessionDescription(type: .answer, sdp: answerSDP),
      on: peerConnection
    )
  }

  func sendInitialQuestion(for ticker: String) {
    send([
      "type": "conversation.item.create",
      "item": [
        "type": "message",
        "role": "user",
        "content": [[
          "type": "input_text",
          "text":
            "Give me the current \(ticker) thesis in plain English: what changed, "
            + "the decisive dated evidence, the principal disagreement, and what would change the read.",
        ]],
      ],
    ])
    send(["type": "response.create"])
  }

  func sendFunctionOutput(callID: String, spokenAnswer: String) {
    send([
      "type": "conversation.item.create",
      "item": [
        "type": "function_call_output",
        "call_id": callID,
        "output": tryJSONString(["spokenAnswer": spokenAnswer]),
      ],
    ])
    send(["type": "response.create"])
  }

  func setMicrophoneEnabled(_ enabled: Bool) {
    localAudioTrack?.isEnabled = enabled
  }

  func disconnect() {
    dataChannel?.delegate = nil
    dataChannel?.close()
    peerConnection?.close()
    dataChannel = nil
    peerConnection = nil
    localAudioTrack = nil
    factory = nil
    hasReportedReady = false
  }

  private func send(_ event: [String: Any]) {
    guard
      let dataChannel,
      dataChannel.readyState == .open,
      let data = try? JSONSerialization.data(withJSONObject: event)
    else { return }
    dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  private func createOfferSDP(
    on peerConnection: RTCPeerConnection,
    constraints: RTCMediaConstraints
  ) async throws -> String {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<String, any Error>) in
      peerConnection.offer(for: constraints) { description, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let description {
          continuation.resume(returning: description.sdp)
        } else {
          continuation.resume(throwing: RealtimeConnectionError.offerFailed)
        }
      }
    }
  }

  private func setLocalDescription(
    _ description: RTCSessionDescription,
    on peerConnection: RTCPeerConnection
  ) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      peerConnection.setLocalDescription(description) { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: ())
        }
      }
    }
  }

  private func setRemoteDescription(
    _ description: RTCSessionDescription,
    on peerConnection: RTCPeerConnection
  ) async throws {
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      peerConnection.setRemoteDescription(description) { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: ())
        }
      }
    }
  }

  private func exchangeSDP(
    _ offer: String,
    endpoint: URL,
    clientSecret: String
  ) async throws -> String {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.httpBody = Data(offer.utf8)
    request.setValue("Bearer \(clientSecret)", forHTTPHeaderField: "Authorization")
    request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
    request.setValue("application/sdp", forHTTPHeaderField: "Accept")
    request.timeoutInterval = 45

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 45
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let (data, response) = try await URLSession(configuration: configuration).data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw RealtimeConnectionError.invalidAnswer
    }
    guard 200..<300 ~= http.statusCode else {
      throw RealtimeConnectionError.upstream(status: http.statusCode)
    }
    guard
      let answer = String(data: data, encoding: .utf8),
      answer.contains("v=0")
    else {
      throw RealtimeConnectionError.invalidAnswer
    }
    return answer
  }

  private func reportReadyIfNeeded() {
    guard !hasReportedReady else { return }
    hasReportedReady = true
    onEvent(.ready)
  }

  private func handleEventData(_ data: Data) {
    guard
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = object["type"] as? String
    else { return }

    switch type {
    case "session.created", "session.updated":
      reportReadyIfNeeded()
    case "input_audio_buffer.speech_started":
      onEvent(.listening)
    case "response.audio.delta", "response.output_audio.delta":
      onEvent(.speaking)
    case "response.function_call_arguments.done":
      if
        let callID = object["call_id"] as? String,
        let name = object["name"] as? String,
        let arguments = object["arguments"] as? String
      {
        onEvent(.functionCall(callID: callID, name: name, arguments: arguments))
      }
    case "response.done":
      if
        let response = object["response"] as? [String: Any],
        let output = response["output"] as? [[String: Any]]
      {
        for item in output where item["type"] as? String == "function_call" {
          if
            let callID = item["call_id"] as? String,
            let name = item["name"] as? String,
            let arguments = item["arguments"] as? String
          {
            onEvent(.functionCall(callID: callID, name: name, arguments: arguments))
          }
        }
      }
      onEvent(.responseFinished)
    case "error":
      let error = object["error"] as? [String: Any]
      let message = error?["message"] as? String ?? "The live connection reported an error."
      onEvent(.failed(message))
    default:
      break
    }
  }

  private func tryJSONString(_ value: Any) -> String {
    guard
      let data = try? JSONSerialization.data(withJSONObject: value),
      let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
  }
}

extension RealtimeWebRTCClient: RTCPeerConnectionDelegate {
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didChange stateChanged: RTCSignalingState
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didAdd stream: RTCMediaStream
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didRemove stream: RTCMediaStream
  ) {}

  nonisolated func peerConnectionShouldNegotiate(
    _ peerConnection: RTCPeerConnection
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didChange newState: RTCIceConnectionState
  ) {
    switch newState {
    case .failed, .disconnected, .closed:
      Task { @MainActor [weak self] in self?.onEvent(.closed) }
    default:
      break
    }
  }

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didChange newState: RTCIceGatheringState
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didGenerate candidate: RTCIceCandidate
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didRemove candidates: [RTCIceCandidate]
  ) {}

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection,
    didOpen dataChannel: RTCDataChannel
  ) {}
}

extension RealtimeWebRTCClient: RTCDataChannelDelegate {
  nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      if self.dataChannel?.readyState == .open {
        self.reportReadyIfNeeded()
      }
    }
  }

  nonisolated func dataChannel(
    _ dataChannel: RTCDataChannel,
    didReceiveMessageWith buffer: RTCDataBuffer
  ) {
    let data = buffer.data
    Task { @MainActor [weak self] in
      self?.handleEventData(data)
    }
  }
}

private enum RealtimeConnectionError: LocalizedError {
  case setupFailed
  case offerFailed
  case invalidAnswer
  case upstream(status: Int)

  var errorDescription: String? {
    switch self {
    case .setupFailed:
      "AMM could not prepare the secure audio connection."
    case .offerFailed:
      "AMM could not create the live audio offer."
    case .invalidAnswer:
      "The live audio service returned an invalid response."
    case .upstream(let status):
      "The live audio service could not start (HTTP \(status))."
    }
  }
}
