import CryptoKit
import Foundation

/// Persists only the server-authored Desk presentation envelope.
///
/// Snapshots are namespaced by a one-way hash of the Clerk user id, protected
/// until the device has been unlocked, and replaced atomically. They let AMM
/// keep the last verified research visible during a transient network failure
/// without ever sharing cached data between signed-in members.
actor DeskSnapshotStore {
  private let rootURL: URL
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(rootURL: URL? = nil) {
    if let rootURL {
      self.rootURL = rootURL
    } else {
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first ?? FileManager.default.temporaryDirectory
      self.rootURL = applicationSupport
        .appendingPathComponent("AMM", isDirectory: true)
        .appendingPathComponent("VerifiedDesk", isDirectory: true)
    }
  }

  func load(userID: String) throws -> DeskEnvelope? {
    let url = fileURL(userID: userID)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try decoder.decode(DeskEnvelope.self, from: Data(contentsOf: url))
  }

  func save(_ desk: DeskEnvelope, userID: String) throws {
    try FileManager.default.createDirectory(
      at: rootURL,
      withIntermediateDirectories: true
    )
    let data = try encoder.encode(desk)
    try data.write(
      to: fileURL(userID: userID),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
  }

  func remove(userID: String) throws {
    let url = fileURL(userID: userID)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    try FileManager.default.removeItem(at: url)
  }

  private func fileURL(userID: String) -> URL {
    let digest = SHA256.hash(data: Data(userID.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
    return rootURL.appendingPathComponent("\(digest).json", isDirectory: false)
  }
}
