import SwiftUI

enum AMMColor {
  static let paper = Color(red: 0.957, green: 0.945, blue: 0.914)
  static let card = Color(red: 0.992, green: 0.986, blue: 0.970)
  static let ink = Color(red: 0.075, green: 0.071, blue: 0.055)
  static let orange = Color(red: 1.000, green: 0.294, blue: 0.137)
  static let cobalt = Color(red: 0.176, green: 0.298, blue: 0.965)
  static let lime = Color(red: 0.817, green: 0.969, blue: 0.267)
  static let positive = Color(red: 0.020, green: 0.482, blue: 0.290)
  static let negative = Color(red: 0.773, green: 0.075, blue: 0.153)
  static let muted = Color(red: 0.390, green: 0.376, blue: 0.337)
  static let rule = Color(red: 0.075, green: 0.071, blue: 0.055).opacity(0.22)
}

struct AMMMonoLabel: View {
  let text: String
  var color: Color = AMMColor.muted

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 11, weight: .semibold, design: .monospaced))
      .tracking(1.8)
      .foregroundStyle(color)
  }
}
struct AMMWordmark: View {
  var size: CGFloat = 24

  var body: some View {
    HStack(alignment: .lastTextBaseline, spacing: 3) {
      Text("AMM")
        .font(.system(size: size, weight: .black, design: .rounded))
        .foregroundStyle(AMMColor.ink)
      BrandTriangle()
        .fill(AMMColor.orange)
        .frame(width: size * 0.38, height: size * 0.34)
        .rotationEffect(.degrees(12))
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("AMM")
  }
}

struct BrandTriangle: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.midX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
    path.closeSubpath()
    return path
  }
}

struct PaperNoise: View {
  var body: some View {
    Canvas { context, size in
      let spacing: CGFloat = 7
      for x in stride(from: CGFloat.zero, through: size.width, by: spacing) {
        for y in stride(from: CGFloat.zero, through: size.height, by: spacing) {
          let value = Int(x * 13 + y * 7) % 19
          guard value == 0 else { continue }
          context.fill(
            Path(ellipseIn: CGRect(x: x, y: y, width: 0.8, height: 0.8)),
            with: .color(AMMColor.ink.opacity(0.025))
          )
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

private struct AMMCardShadowModifier: ViewModifier {
  let depth: CGFloat

  func body(content: Content) -> some View {
    content
      .background(AMMColor.card)
      .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(AMMColor.ink, lineWidth: 2)
      }
      .background {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(AMMColor.ink)
          .offset(x: depth, y: depth)
      }
  }
}

extension View {
  func ammCardShadow(depth: CGFloat = 5) -> some View {
    modifier(AMMCardShadowModifier(depth: depth))
  }
}

struct AMMPrimaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 16, weight: .bold, design: .rounded))
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 16)
      .background(configuration.isPressed ? AMMColor.orange.opacity(0.78) : AMMColor.orange)
      .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 15, style: .continuous)
          .stroke(AMMColor.ink, lineWidth: 2)
      }
      .offset(y: configuration.isPressed ? 2 : 0)
  }
}

struct AMMAvatarMark: View {
  var body: some View {
    ZStack {
      Circle().fill(AMMColor.ink)
      BrandTriangle()
        .fill(AMMColor.orange)
        .rotationEffect(.degrees(12))
        .padding(10)
    }
    .accessibilityHidden(true)
  }
}
