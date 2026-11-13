import Foundation

struct DeskEnvelope: Codable, Sendable {
  let schemaVersion: Int
  let generatedAt: String
  let member: Member
  let desk: Desk
  let voice: VoiceAllowance?
  let cards: [DeskCard]

  struct Member: Codable, Sendable {
    let firstName: String
  }

  struct Desk: Codable, Sendable {
    let tier: String
    let active: Bool
    let tickers: [String]
    let noteTime: String
    let timeZone: String
  }
}

struct VoiceAllowance: Codable, Equatable, Sendable {
  let allowed: Bool
  let sessionId: String?
  let usedSeconds: Int
  let quotaSeconds: Int
  let remainingSeconds: Int
  let reason: String?
}

struct DeskCard: Codable, Identifiable, Hashable, Sendable {
  var id: String { ticker }

  let ticker: String
  let companyName: String
  let href: String
  let date: String
  let price: Double?
  let dayChangePercent: Double?
  let afterHoursChangePercent: Double?
  let status: String
  let whatChanged: String
  let thesis: String
  let previewThesis: String
  let whyItMatters: String
  let evidence: [String]
  let votes: Votes
  let majorityReason: String
  let holdBackReason: String?
  let flipCondition: String?
  let nextEvent: String?
  let editorialScore: Double
  let hasResearch: Bool
  let lifecycle: ThesisLifecycle?
  let signal: Signal?
  let movement: ThesisMovement?

  struct Votes: Codable, Hashable, Sendable {
    let support: Int
    let oppose: Int
    let uncertain: Int
    let unavailable: Int?

    var total: Int {
      support + oppose + uncertain + (unavailable ?? 0)
    }
  }

  struct ThesisLifecycle: Codable, Hashable, Sendable {
    let openedDate: String
    let observationIndex: Int
    let status: String
  }

  struct Signal: Codable, Hashable, Sendable {
    let direction: Direction
    let strength: Strength
    let horizonSessions: Horizon

    enum Direction: String, Codable, Hashable, Sendable {
      case up = "UP"
      case down = "DOWN"
      case neutral = "NEUTRAL"
    }

    enum Strength: String, Codable, Hashable, Sendable {
      case gentle = "GENTLE"
      case moderate = "MODERATE"
      case strong = "STRONG"
      case neutral = "NEUTRAL"
    }

    struct Horizon: Codable, Hashable, Sendable {
      let min: Int
      let max: Int
    }

    var fivePointScore: Int {
      switch (direction, strength) {
      case (.up, .strong): 2
      case (.up, _): 1
      case (.down, .strong): -2
      case (.down, _): -1
      case (.neutral, _): 0
      }
    }

    var label: String {
      switch fivePointScore {
      case 2: "STRONG UPSIDE"
      case 1: "GENTLE UPSIDE"
      case -2: "STRONG DOWNSIDE"
      case -1: "GENTLE DOWNSIDE"
      default: "NEUTRAL"
      }
    }
  }

  struct ThesisMovement: Codable, Hashable, Sendable {
    let observations: [Observation]
    let window: Window
    let currentScore: Double
    let currentLabel: String
    let currentSupport: Int
    let currentTotal: Int

    struct Observation: Codable, Hashable, Sendable {
      let date: String
      let observedAt: Double
      let index: Int
      let status: String
      let score: Double
      let support: Int
      let oppose: Int
      let uncertain: Int
      let unavailable: Int
      let auditId: String?
    }

    struct Window: Codable, Hashable, Sendable {
      let startDate: String
      let startLabel: String
      let endDate: String
      let endLabel: String
    }
  }
}

struct DeskMutationRequest: Encodable, Sendable {
  let tickers: [String]
  let noteTime: String
  let tz: String
}

struct DeskMutationResponse: Decodable, Sendable {
  let id: String
  let created: Bool
  let tickers: [String]
  let additions: [String]
}

struct StockEnvelope: Decodable, Sendable {
  let schemaVersion: Int
  let generatedAt: String
  let company: Company
  let voice: VoiceAllowance?
  let deskCard: DeskCard?
  let current: ChairmanRun?
  let runs: [ChairmanRun]
  let sources: [Source]

  struct Company: Decodable, Sendable {
    let ticker: String
    let name: String
    let price: Double?
    let dayChangePercent: Double?
    let afterHoursChangePercent: Double?
    let nextEvent: String?
  }

  struct Source: Decodable, Identifiable, Sendable {
    let id: Int
    let title: String
    let url: String
    let date: String?
    let sourceType: String
    let evidenceState: String?
  }
}

struct ChairmanRun: Decodable, Identifiable, Sendable {
  var id: String { "\(ticker)-\(date)-\(generatedAt)" }
  let ticker: String
  let date: String
  let generatedAt: Double
  let signalTrack: PublicSignalTrack?
  let signal: Signal
  let cards: [ChairmanCard]

  struct Signal: Decodable, Sendable {
    let direction: String
    let strength: String
    let minSessions: Int
    let maxSessions: Int
    let support: Int
    let oppose: Int
    let uncertain: Int
  }
}

struct ChairmanCard: Decodable, Identifiable, Sendable {
  let id: String
  let label: String
  let title: String
  let markdown: String
}

struct PublicSignalTrack: Decodable, Sendable {
  let direction: String
  let strength: String
  let issueDate: String
  let horizon: Horizon
  let state: String
  let forecastYPercent: Double
  let sessionCount: Int
  let observedMovePct: Double?
  let asOfDate: String?
  let points: [Point]

  struct Horizon: Decodable, Sendable {
    let min: Int
    let max: Int
  }

  struct Point: Decodable, Identifiable, Sendable {
    var id: String { "\(date)-\(session)" }
    let date: String
    let session: Int
    let cumulativeReturnPct: Double
    let xPercent: Double
    let yPercent: Double
  }
}

struct VoiceTokenRequest: Encodable, Sendable {
  let ticker: String
}

struct VoiceTokenResponse: Decodable, Sendable {
  let schemaVersion: Int
  let ticker: String
  let clientSecret: String
  let expiresAt: Double
  let realtimeSessionId: String?
  let voiceSessionId: String
  let model: String
  let voice: String
  let quotaSeconds: Int
  let remainingSeconds: Int
  let webRtcEndpoint: String
  let heartbeatPath: String
  let toolPath: String
}

struct VoiceToolRequest: Encodable, Sendable {
  let sessionId: String
  let question: String
}

struct VoiceToolResponse: Decodable, Equatable, Sendable {
  let ticker: String?
  let answer: String?
  let spokenAnswer: String
  let citations: [VoiceCitation]?
  let evidenceCutoff: Double?
  let allowance: VoiceAllowance?
}

struct VoiceCitation: Codable, Identifiable, Hashable, Sendable {
  var id: String { "\(label)|\(href ?? "")" }
  let label: String
  let href: String?
}

enum VoiceToolStreamEvent: Equatable, Sendable {
  case progress(String)
  case completed(VoiceToolResponse)
  case failed(String)

  static func decodeServerSentLine(_ line: String) throws -> VoiceToolStreamEvent? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("data:") else { return nil }
    let rawJSON = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
    guard let data = rawJSON.data(using: .utf8) else { return nil }
    let frame = try JSONDecoder().decode(VoiceToolEventFrame.self, from: data)

    switch frame.type {
    case "line":
      guard let text = frame.text, !text.isEmpty else { return nil }
      return .progress(text)
    case "done":
      guard let result = try? JSONDecoder().decode(VoiceToolResponse.self, from: data) else {
        return .failed("AMM received an incomplete verified voice answer.")
      }
      return .completed(result)
    case "error":
      return .failed(frame.text ?? "AMM could not complete the dated-source check.")
    default:
      return nil
    }
  }
}

private struct VoiceToolEventFrame: Decodable {
  let type: String
  let text: String?
}

struct RealtimeFunctionArguments: Decodable, Sendable {
  let question: String
}

struct VoiceHeartbeatRequest: Encodable, Sendable {
  let sessionId: String
  let finish: Bool
}

struct VoiceHeartbeatResponse: Decodable, Sendable {
  let allowance: VoiceAllowance
}

struct SittingRequest: Encodable, Sendable {
  let ticker: String
  let question: String
  let sessionId: String?
  let documentIds: [String]?

  init(
    ticker: String,
    question: String,
    sessionId: String?,
    documentIds: [String]? = nil
  ) {
    self.ticker = ticker
    self.question = question
    self.sessionId = sessionId
    self.documentIds = documentIds
  }
}

struct SittingCompletion: Equatable, Sendable {
  let sessionId: String
  let answer: String
  let used: Int?
  let cap: Int?
}

enum SittingStreamEvent: Equatable, Sendable {
  case progress(String)
  case verifiedAnswer(String)
  case completed(SittingCompletion)
  case quota(used: Int, cap: Int, offer: String?)
  case failed(String)

  static func decodeServerSentLine(_ line: String) throws -> SittingStreamEvent? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("data:") else { return nil }
    let rawJSON = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
    guard let data = rawJSON.data(using: .utf8) else { return nil }
    let frame = try JSONDecoder().decode(SittingEventFrame.self, from: data)

    switch frame.type {
    case "line":
      guard let text = frame.text, !text.isEmpty else { return nil }
      return .progress(text)
    case "answer":
      guard let text = frame.text, !text.isEmpty else { return nil }
      return .verifiedAnswer(text)
    case "done":
      guard
        let sessionId = frame.sessionId,
        let answer = frame.answer,
        !sessionId.isEmpty,
        !answer.isEmpty
      else {
        return .failed("AMM received an incomplete verified answer.")
      }
      return .completed(
        SittingCompletion(
          sessionId: sessionId,
          answer: answer,
          used: frame.used,
          cap: frame.cap
        )
      )
    case "wall":
      let offer = frame.wall.map {
        [$0.label, $0.blurb, $0.price]
          .compactMap { $0 }
          .filter { !$0.isEmpty }
          .joined(separator: " · ")
      }
      return .quota(
        used: frame.used ?? 0,
        cap: frame.cap ?? 0,
        offer: offer?.isEmpty == false ? offer : nil
      )
    case "error":
      return .failed(frame.text ?? "AMM Desk could not answer that question.")
    case "notes":
      // Single-model mobile chat deliberately exposes no draft or hidden reasoning.
      return nil
    default:
      return nil
    }
  }
}

private struct SittingEventFrame: Decodable {
  let type: String
  let text: String?
  let answer: String?
  let sessionId: String?
  let used: Int?
  let cap: Int?
  let wall: Wall?

  struct Wall: Decodable {
    let label: String?
    let price: String?
    let blurb: String?
  }
}
