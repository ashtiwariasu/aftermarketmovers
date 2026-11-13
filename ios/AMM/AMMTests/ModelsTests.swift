import Foundation
import Testing
@testable import AMM

struct ModelsTests {
  @Test
  func deskContractDecodesCanonicalSignalAndQuota() throws {
    let data = Data(
      """
      {
        "schemaVersion": 1,
        "generatedAt": "2026-07-26T00:00:00.000Z",
        "member": { "firstName": "Ash" },
        "desk": {
          "tier": "pro",
          "active": true,
          "tickers": ["AMZN"],
          "noteTime": "07:00",
          "timeZone": "Australia/Brisbane"
        },
        "voice": {
          "allowed": true,
          "sessionId": null,
          "usedSeconds": 120,
          "quotaSeconds": 900,
          "remainingSeconds": 780,
          "reason": null
        },
        "cards": [{
          "ticker": "AMZN",
          "companyName": "Amazon.com, Inc.",
          "href": "/stock/amzn",
          "date": "JUL 25",
          "price": 232.72,
          "dayChangePercent": -0.4,
          "afterHoursChangePercent": 0,
          "status": "signal",
          "whatChanged": "Fresh evidence entered the file.",
          "thesis": "Amazon thesis",
          "previewThesis": "Amazon thesis",
          "whyItMatters": "The evidence changes the read.",
          "evidence": ["One", "Two"],
          "votes": {
            "support": 3,
            "oppose": 0,
            "uncertain": 2,
            "unavailable": 0
          },
          "majorityReason": "Three support.",
          "holdBackReason": "Two wait.",
          "flipCondition": "A filing changes the view.",
          "nextEvent": "Q2 earnings",
          "editorialScore": 12,
          "hasResearch": true,
          "lifecycle": {
            "openedDate": "2026-04-30",
            "observationIndex": 5,
            "status": "strengthened"
          },
          "signal": {
            "direction": "DOWN",
            "strength": "MODERATE",
            "horizonSessions": { "min": 10, "max": 15 }
          },
          "movement": null
        }]
      }
      """.utf8
    )

    let envelope = try JSONDecoder().decode(DeskEnvelope.self, from: data)
    #expect(envelope.member.firstName == "Ash")
    #expect(envelope.voice?.remainingSeconds == 780)
    #expect(envelope.cards.first?.signal?.fivePointScore == -1)
    #expect(envelope.cards.first?.votes.total == 5)

    let encoded = try JSONEncoder().encode(envelope)
    let restored = try JSONDecoder().decode(DeskEnvelope.self, from: encoded)
    #expect(restored.cards.first?.previewThesis == "Amazon thesis")
  }

  @Test
  func verifiedDeskSnapshotIsProtectedAndUserScoped() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("amm-desk-cache-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let data = Data(
      """
      {
        "schemaVersion": 1,
        "generatedAt": "2026-07-26T00:00:00.000Z",
        "member": { "firstName": "Ash" },
        "desk": {
          "tier": "pro",
          "active": true,
          "tickers": ["AMZN"],
          "noteTime": "07:00",
          "timeZone": "Australia/Brisbane"
        },
        "voice": null,
        "cards": []
      }
      """.utf8
    )
    let desk = try JSONDecoder().decode(DeskEnvelope.self, from: data)
    let store = DeskSnapshotStore(rootURL: root)

    try await store.save(desk, userID: "user_A")
    let sameUser = try await store.load(userID: "user_A")
    let otherUser = try await store.load(userID: "user_B")
    let cachedFiles = try FileManager.default.contentsOfDirectory(atPath: root.path)

    #expect(sameUser?.desk.tickers == ["AMZN"])
    #expect(otherUser == nil)
    #expect(cachedFiles.allSatisfy { !$0.contains("user_A") })
  }

  @Test
  func fivePointScaleNeverInventsModeratePublicBands() {
    let moderateDown = DeskCard.Signal(
      direction: .down,
      strength: .moderate,
      horizonSessions: .init(min: 10, max: 15)
    )
    let strongUp = DeskCard.Signal(
      direction: .up,
      strength: .strong,
      horizonSessions: .init(min: 10, max: 15)
    )

    #expect(moderateDown.fivePointScore == -1)
    #expect(moderateDown.label == "GENTLE DOWNSIDE")
    #expect(strongUp.fivePointScore == 2)
    #expect(strongUp.label == "STRONG UPSIDE")
  }

  @Test
  func stockContractCarriesTheExactAuditedDeskCardAndLifecycle() throws {
    let data = Data(
      """
      {
        "schemaVersion": 1,
        "generatedAt": "2026-07-26T00:00:00.000Z",
        "company": {
          "ticker": "AMZN",
          "name": "Amazon.com, Inc.",
          "price": 232.72,
          "dayChangePercent": -0.4,
          "afterHoursChangePercent": 0,
          "nextEvent": "Q2 earnings"
        },
        "voice": null,
        "deskCard": {
          "ticker": "AMZN",
          "companyName": "Amazon.com, Inc.",
          "href": "/stock/amzn",
          "date": "2026-07-25",
          "price": 232.72,
          "dayChangePercent": -0.4,
          "afterHoursChangePercent": 0,
          "status": "flag",
          "whatChanged": "Peers raised spending expectations.",
          "thesis": "Amazon is being sold for spending it has not disclosed.",
          "previewThesis": "Amazon is being sold for spending it has not disclosed.",
          "whyItMatters": "The active thesis is being tested.",
          "evidence": ["Filed evidence", "Dated report"],
          "votes": {
            "support": 3,
            "oppose": 0,
            "uncertain": 2,
            "unavailable": 0
          },
          "majorityReason": "Three support the standing thesis.",
          "holdBackReason": "Two want filed guidance.",
          "flipCondition": "Filed guidance changes the view.",
          "nextEvent": "Q2 earnings",
          "editorialScore": 12,
          "hasResearch": true,
          "lifecycle": {
            "openedDate": "2026-04-30",
            "observationIndex": 4,
            "status": "weakened"
          },
          "signal": {
            "direction": "DOWN",
            "strength": "MODERATE",
            "horizonSessions": { "min": 10, "max": 15 }
          },
          "movement": {
            "observations": [
              {
                "date": "2026-04-30",
                "observedAt": 1777500000000,
                "index": 1,
                "status": "opened",
                "score": -1,
                "support": 3,
                "oppose": 0,
                "uncertain": 2,
                "unavailable": 0,
                "auditId": "audit-open"
              },
              {
                "date": "2026-07-25",
                "observedAt": 1784940000000,
                "index": 4,
                "status": "weakened",
                "score": -0.5,
                "support": 3,
                "oppose": 0,
                "uncertain": 2,
                "unavailable": 0,
                "auditId": "audit-current"
              }
            ],
            "window": {
              "startDate": "2026-04-30",
              "startLabel": "Q1 2026 RESULTS · APR 30",
              "endDate": "2026-07-30",
              "endLabel": "Q2 2026 EARNINGS · JUL 30"
            },
            "currentScore": -0.5,
            "currentLabel": "GENTLE DOWNSIDE",
            "currentSupport": 3,
            "currentTotal": 5
          }
        },
        "current": null,
        "runs": [],
        "sources": []
      }
      """.utf8
    )

    let envelope = try JSONDecoder().decode(StockEnvelope.self, from: data)
    #expect(
      envelope.deskCard?.previewThesis ==
        "Amazon is being sold for spending it has not disclosed."
    )
    #expect(envelope.deskCard?.whatChanged == "Peers raised spending expectations.")
    #expect(envelope.deskCard?.lifecycle?.status == "weakened")
    #expect(envelope.deskCard?.movement?.observations.count == 2)
    #expect(envelope.deskCard?.movement?.currentLabel == "GENTLE DOWNSIDE")
  }

  @Test
  func transportAllowsProductionHTTPSAndLocalDevelopmentOnly() throws {
    #expect(
      AMMConfiguration.isAllowedAPIBaseURL(
        try #require(URL(string: "https://aftermarketmovers.com"))
      )
    )
    #expect(
      AMMConfiguration.isAllowedAPIBaseURL(
        try #require(URL(string: "http://127.0.0.1:3000"))
      )
    )
    #expect(
      !AMMConfiguration.isAllowedAPIBaseURL(
        try #require(URL(string: "http://aftermarketmovers.com"))
      )
    )
    #expect(
      AMMConfiguration.isTrustedRealtimeEndpoint(
        try #require(URL(string: "https://api.openai.com/v1/realtime/calls"))
      )
    )
    #expect(
      !AMMConfiguration.isTrustedRealtimeEndpoint(
        try #require(URL(string: "https://example.com/v1/realtime/calls"))
      )
    )
  }

  @Test
  func sittingProgressDecodesWithoutExposingLegacyNotes() throws {
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"line","text":"Matching this question to the strongest evidence…"}"#
      ) == .progress("Matching this question to the strongest evidence…")
    )
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"notes","text":"unreleased draft"}"#
      ) == nil
    )
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"event: heartbeat"#
      ) == nil
    )
  }

  @Test
  func sittingAnswerAndCompletionDecodeAsVerifiedReceipts() throws {
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"answer","text":"Verified answer [S2 · 2026-07-24]."}"#
      ) == .verifiedAnswer("Verified answer [S2 · 2026-07-24].")
    )

    let completion = try #require(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"done","sessionId":"local-1234567890-abcd","answer":"Verified answer [S2 · 2026-07-24].","used":4,"cap":30}"#
      )
    )
    #expect(
      completion == .completed(
        SittingCompletion(
          sessionId: "local-1234567890-abcd",
          answer: "Verified answer [S2 · 2026-07-24].",
          used: 4,
          cap: 30
        )
      )
    )
  }

  @Test
  func sittingQuotaAndFailureRemainExplicit() throws {
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"wall","used":30,"cap":30,"wall":{"label":"AMM Ultra","price":"$399/mo","blurb":"30 companies"}}"#
      ) == .quota(
        used: 30,
        cap: 30,
        offer: "AMM Ultra · 30 companies · $399/mo"
      )
    )
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"error","text":"No answer was released."}"#
      ) == .failed("No answer was released.")
    )
    #expect(
      try SittingStreamEvent.decodeServerSentLine(
        #"data: {"type":"done","sessionId":"","answer":""}"#
      ) == .failed("AMM received an incomplete verified answer.")
    )
  }

  @Test
  func voiceToolStreamsProgressButReleasesFactsOnlyInTerminalReceipt() throws {
    #expect(
      try VoiceToolStreamEvent.decodeServerSentLine(
        #"data: {"type":"line","text":"Checking the relevant company file and dated sources…"}"#
      ) == .progress("Checking the relevant company file and dated sources…")
    )
    #expect(
      try VoiceToolStreamEvent.decodeServerSentLine(
        #": source-check-active"#
      ) == nil
    )

    let event = try #require(
      try VoiceToolStreamEvent.decodeServerSentLine(
        #"data: {"type":"done","ticker":"AMZN","answer":"Verified [source](https://example.com).","spokenAnswer":"Verified.","citations":[{"label":"SEC · 2026-07-24","href":"https://example.com"}],"evidenceCutoff":1784851200000,"allowance":{"allowed":true,"sessionId":"voice-123","usedSeconds":60,"quotaSeconds":900,"remainingSeconds":840,"reason":null}}"#
      )
    )
    guard case .completed(let result) = event else {
      Issue.record("Expected a terminal verified voice result")
      return
    }
    #expect(result.ticker == "AMZN")
    #expect(result.spokenAnswer == "Verified.")
    #expect(result.citations?.first?.label == "SEC · 2026-07-24")
    #expect(result.allowance?.remainingSeconds == 840)
  }

  @Test
  func voiceToolFailureAndMalformedTerminalReceiptFailClosed() throws {
    #expect(
      try VoiceToolStreamEvent.decodeServerSentLine(
        #"data: {"type":"error","text":"No answer passed the dated-source check."}"#
      ) == .failed("No answer passed the dated-source check.")
    )
    #expect(
      try VoiceToolStreamEvent.decodeServerSentLine(
        #"data: {"type":"done","ticker":"AMZN"}"#
      ) == .failed("AMM received an incomplete verified voice answer.")
    )
  }
}
