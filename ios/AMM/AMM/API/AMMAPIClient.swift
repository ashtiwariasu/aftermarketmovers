import ClerkKit
import Foundation

enum AMMAPIError: LocalizedError, Equatable {
  case signedOut
  case invalidResponse
  case rejected(status: Int, message: String, code: String?)
  case transport(String)

  var errorDescription: String? {
    switch self {
    case .signedOut:
      "Your AMM session has ended. Sign in again."
    case .invalidResponse:
      "AMM received an unreadable response."
    case .rejected(_, let message, _):
      message
    case .transport(let message):
      message
    }
  }

  static func message(for error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "AMM could not connect. Try again."
  }
}

struct APIErrorBody: Decodable {
  let error: String?
  let code: String?
}

@MainActor
final class AMMAPIClient {
  private let baseURL: URL
  private let session: URLSession
  private let streamingSession: URLSession
  private let decoder: JSONDecoder
  private let encoder: JSONEncoder

  init(baseURL: URL = AMMConfiguration.apiBaseURL) {
    self.baseURL = baseURL
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 120
    configuration.waitsForConnectivity = true
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    self.session = URLSession(configuration: configuration)
    let streamingConfiguration = URLSessionConfiguration.ephemeral
    streamingConfiguration.timeoutIntervalForRequest = 900
    streamingConfiguration.timeoutIntervalForResource = 900
    streamingConfiguration.waitsForConnectivity = true
    streamingConfiguration.requestCachePolicy = .reloadIgnoringLocalCacheData
    self.streamingSession = URLSession(configuration: streamingConfiguration)
    self.decoder = JSONDecoder()
    self.encoder = JSONEncoder()
  }

  func get<Response: Decodable>(_ path: String) async throws -> Response {
    try await request(path: path, method: "GET", body: Optional<EmptyBody>.none)
  }

  func post<Body: Encodable, Response: Decodable>(
    _ path: String,
    body: Body
  ) async throws -> Response {
    try await request(path: path, method: "POST", body: body)
  }

  /// Streams safe progress receipts while the server retrieves and verifies.
  /// The server emits the answer only after the deterministic source gate passes.
  func streamSitting(
    body: SittingRequest,
    onEvent: @MainActor @escaping (SittingStreamEvent) -> Void
  ) async throws {
    guard let token = try await Clerk.shared.auth.getToken() else {
      throw AMMAPIError.signedOut
    }
    guard let url = URL(string: "/api/desk/sitting/run", relativeTo: baseURL) else {
      throw AMMAPIError.invalidResponse
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("AMM-iOS/1", forHTTPHeaderField: "X-AMM-Client")
    request.httpBody = try encoder.encode(body)
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.timeoutInterval = 900

    do {
      let (bytes, response) = try await streamingSession.bytes(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw AMMAPIError.invalidResponse
      }
      guard 200..<300 ~= http.statusCode else {
        var responseData = Data()
        for try await byte in bytes {
          responseData.append(byte)
          if responseData.count >= 64_000 { break }
        }
        let payload = try? decoder.decode(APIErrorBody.self, from: responseData)
        throw AMMAPIError.rejected(
          status: http.statusCode,
          message: payload?.error ?? "AMM could not complete that request.",
          code: payload?.code
        )
      }

      for try await line in bytes.lines {
        try Task.checkCancellation()
        if let event = try SittingStreamEvent.decodeServerSentLine(line) {
          onEvent(event)
        }
      }
    } catch let error as AMMAPIError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw AMMAPIError.transport(
        "AMM could not connect. Check your connection and try again."
      )
    }
  }

  /// Streams only safe process receipts from the voice tool. The terminal
  /// payload is emitted after the complete answer passes the dated-source gate.
  func streamVoiceTool(
    path: String,
    body: VoiceToolRequest,
    onEvent: @MainActor @escaping (VoiceToolStreamEvent) -> Void
  ) async throws {
    guard let token = try await Clerk.shared.auth.getToken() else {
      throw AMMAPIError.signedOut
    }
    guard
      path.hasPrefix("/api/desk/voice/"),
      let url = URL(string: path, relativeTo: baseURL),
      url.host == baseURL.host
    else {
      throw AMMAPIError.invalidResponse
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("AMM-iOS/1", forHTTPHeaderField: "X-AMM-Client")
    request.httpBody = try encoder.encode(body)
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.timeoutInterval = 900

    do {
      let (bytes, response) = try await streamingSession.bytes(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw AMMAPIError.invalidResponse
      }
      guard 200..<300 ~= http.statusCode else {
        var responseData = Data()
        for try await byte in bytes {
          responseData.append(byte)
          if responseData.count >= 64_000 { break }
        }
        let payload = try? decoder.decode(APIErrorBody.self, from: responseData)
        throw AMMAPIError.rejected(
          status: http.statusCode,
          message: payload?.error ?? "AMM could not complete the dated-source check.",
          code: payload?.code
        )
      }

      for try await line in bytes.lines {
        try Task.checkCancellation()
        if let event = try VoiceToolStreamEvent.decodeServerSentLine(line) {
          onEvent(event)
        }
      }
    } catch let error as AMMAPIError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw AMMAPIError.transport(
        "AMM could not connect. Check your connection and try again."
      )
    }
  }

  private func request<Body: Encodable, Response: Decodable>(
    path: String,
    method: String,
    body: Body?
  ) async throws -> Response {
    guard let token = try await Clerk.shared.auth.getToken() else {
      throw AMMAPIError.signedOut
    }
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw AMMAPIError.invalidResponse
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("AMM-iOS/1", forHTTPHeaderField: "X-AMM-Client")
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    if let body {
      request.httpBody = try encoder.encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw AMMAPIError.invalidResponse
      }
      guard 200..<300 ~= http.statusCode else {
        let payload = try? decoder.decode(APIErrorBody.self, from: data)
        throw AMMAPIError.rejected(
          status: http.statusCode,
          message: payload?.error ?? "AMM could not complete that request.",
          code: payload?.code
        )
      }
      do {
        return try decoder.decode(Response.self, from: data)
      } catch {
        throw AMMAPIError.invalidResponse
      }
    } catch let error as AMMAPIError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw AMMAPIError.transport("AMM could not connect. Check your connection and try again.")
    }
  }
}

private struct EmptyBody: Encodable {}
