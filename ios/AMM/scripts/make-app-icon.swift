#!/usr/bin/env swift

import AppKit

let output = CommandLine.arguments.dropFirst().first ?? "AMM/Resources/Assets.xcassets/AppIcon.appiconset/AMM-AppIcon.png"
let size = NSSize(width: 1024, height: 1024)
guard let context = CGContext(
  data: nil,
  width: 1024,
  height: 1024,
  bitsPerComponent: 8,
  bytesPerRow: 1024 * 4,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else {
  fputs("Could not create AMM app icon canvas\n", stderr)
  exit(1)
}
let graphics = NSGraphicsContext(cgContext: context, flipped: false)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
NSColor(calibratedRed: 0.957, green: 0.945, blue: 0.914, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

let word = "AMM" as NSString
let attributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 260, weight: .black),
  .foregroundColor: NSColor(calibratedRed: 0.075, green: 0.071, blue: 0.055, alpha: 1),
]
let wordSize = word.size(withAttributes: attributes)
let wordOrigin = NSPoint(
  x: (size.width - wordSize.width) / 2 - 45,
  y: (size.height - wordSize.height) / 2 - 8
)
word.draw(at: wordOrigin, withAttributes: attributes)

let triangle = NSBezierPath()
let triangleCenter = NSPoint(
  x: wordOrigin.x + wordSize.width + 58,
  y: size.height / 2 - 10
)
triangle.move(to: NSPoint(x: triangleCenter.x, y: triangleCenter.y + 92))
triangle.line(to: NSPoint(x: triangleCenter.x + 86, y: triangleCenter.y - 76))
triangle.line(to: NSPoint(x: triangleCenter.x - 74, y: triangleCenter.y - 54))
triangle.close()
NSColor(calibratedRed: 1, green: 0.294, blue: 0.137, alpha: 1).setFill()
triangle.fill()
NSGraphicsContext.restoreGraphicsState()

guard let rendered = context.makeImage() else {
  fputs("Could not render AMM app icon\n", stderr)
  exit(1)
}
let bitmap = NSBitmapImageRep(cgImage: rendered)
guard let data = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Could not render AMM app icon\n", stderr)
  exit(1)
}

let url = URL(fileURLWithPath: output)
try FileManager.default.createDirectory(
  at: url.deletingLastPathComponent(),
  withIntermediateDirectories: true
)
try data.write(to: url, options: .atomic)
print(url.path)
