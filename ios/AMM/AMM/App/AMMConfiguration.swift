import Foundation

enum AMMConfiguration {
  static var apiBaseURL: URL {
    guard
      let value = Bundle.main.object(forInfoDictionaryKey: "AMMAPIBaseURL") as? String,
      let url = URL(string: value),
      isAllowedAPIBaseURL(url)
    else {
      preconditionFailure(
        "AMMAPIBaseURL must use HTTPS (HTTP is allowed only for local development)"
      )
    }
    return url
  }

  static func isAllowedAPIBaseURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    if scheme == "https" { return true }
    guard scheme == "http", let host = url.host?.lowercased() else { return false }
    return ["localhost", "127.0.0.1", "::1"].contains(host)
  }

  static func isTrustedRealtimeEndpoint(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "https"
      && url.host?.lowercased() == "api.openai.com"
      && url.path == "/v1/realtime/calls"
  }

  static var clerkPublishableKey: String {
    guard
      let value = Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String,
      value.hasPrefix("pk_")
    else {
      preconditionFailure(
        "Set CLERK_PUBLISHABLE_KEY in an uncommitted Xcode configuration before running AMM"
      )
    }
    return value
  }
}
