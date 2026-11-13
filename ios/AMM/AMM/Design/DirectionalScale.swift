import SwiftUI

struct DirectionalScale: View {
  let score: Int
  var compact = false

  private let stops = [
    (-2, "STRONG\nDOWNSIDE"),
    (-1, "GENTLE\nDOWNSIDE"),
    (0, "NEUTRAL"),
    (1, "GENTLE\nUPSIDE"),
    (2, "STRONG\nUPSIDE"),
  ]

  var body: some View {
    VStack(spacing: 8) {
      GeometryReader { proxy in
        let inset: CGFloat = compact ? 13 : 18
        let available = max(1, proxy.size.width - inset * 2)
        let x = { (value: Int) in
          inset + available * CGFloat(value + 2) / 4
        }

        ZStack(alignment: .leading) {
          Path { path in
            path.move(to: CGPoint(x: x(-2), y: 17))
            path.addLine(to: CGPoint(x: x(0), y: 17))
          }
          .stroke(AMMColor.orange, lineWidth: 2)
          Path { path in
            path.move(to: CGPoint(x: x(0), y: 17))
            path.addLine(to: CGPoint(x: x(2), y: 17))
          }
          .stroke(AMMColor.cobalt, lineWidth: 2)

          ForEach(stops, id: \.0) { stop in
            Circle()
              .fill(AMMColor.card)
              .overlay {
                Circle()
                  .stroke(
                    stop.0 < 0 ? AMMColor.orange : stop.0 > 0 ? AMMColor.cobalt : AMMColor.ink,
                    lineWidth: 2
                  )
              }
              .frame(width: compact ? 20 : 28, height: compact ? 20 : 28)
              .position(x: x(stop.0), y: 17)
          }

          Circle()
            .fill(AMMColor.card)
            .overlay {
              Circle()
                .stroke(
                  score < 0 ? AMMColor.orange : score > 0 ? AMMColor.cobalt : AMMColor.ink,
                  lineWidth: 3
                )
            }
            .frame(width: compact ? 31 : 40, height: compact ? 31 : 40)
            .overlay {
              BrandTriangle()
                .fill(AMMColor.orange)
                .rotationEffect(.degrees(12))
                .padding(compact ? 9 : 12)
            }
            .position(x: x(max(-2, min(2, score))), y: 17)
        }
      }
      .frame(height: compact ? 34 : 42)

      if !compact {
        HStack(alignment: .top) {
          ForEach(stops, id: \.0) { stop in
            Text(stop.1)
              .font(.system(size: 8, weight: .semibold, design: .monospaced))
              .multilineTextAlignment(.center)
              .foregroundStyle(stop.0 < 0 ? AMMColor.orange : stop.0 > 0 ? AMMColor.cobalt : AMMColor.ink)
              .frame(maxWidth: .infinity)
          }
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    stops.first(where: { $0.0 == score })?.1.replacingOccurrences(of: "\n", with: " ") ?? "Neutral"
  }
}

struct VoteTriangles: View {
  let votes: DeskCard.Votes

  var body: some View {
    HStack(spacing: 8) {
      HStack(spacing: 5) {
        ForEach(0..<5, id: \.self) { index in
          BrandTriangle()
            .fill(index < votes.support ? AMMColor.orange : .clear)
            .overlay {
              BrandTriangle()
                .stroke(
                  index < votes.support ? AMMColor.orange : AMMColor.muted.opacity(0.45),
                  lineWidth: 1.2
                )
            }
            .rotationEffect(.degrees(12))
            .frame(width: 13, height: 12)
        }
      }
      Text("\(votes.support)/5 AGREE")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(AMMColor.ink)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(votes.support) of 5 analysts agree")
  }
}

struct ThesisMovementView: View {
  let movement: DeskCard.ThesisMovement
  var compact = false

  private var observations: [DeskCard.ThesisMovement.Observation] {
    movement.observations.sorted {
      if $0.date == $1.date { return $0.observedAt < $1.observedAt }
      return $0.date < $1.date
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 7 : 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        AMMMonoLabel(text: "Thesis movement")
        Spacer()
        Text("CURRENT · \(movement.currentLabel) · \(movement.currentSupport)/\(movement.currentTotal)")
          .font(.system(size: compact ? 7 : 9, weight: .bold, design: .monospaced))
          .foregroundStyle(AMMColor.cobalt)
          .lineLimit(1)
          .minimumScaleFactor(0.72)
      }

      GeometryReader { proxy in
        let width = max(1, proxy.size.width)
        let height = max(1, proxy.size.height)
        let points = plottedPoints(width: width, height: height)

        ZStack(alignment: .topLeading) {
          Path { path in
            path.move(to: CGPoint(x: 0, y: height * 0.82))
            path.addLine(to: CGPoint(x: width, y: height * 0.82))
          }
          .stroke(
            AMMColor.muted.opacity(0.34),
            style: StrokeStyle(lineWidth: 1, dash: [3, 4])
          )

          if let first = points.first {
            Path { path in
              var currentY = first.y
              path.move(to: CGPoint(x: 0, y: first.y))
              for point in points {
                path.addLine(to: CGPoint(x: point.x, y: currentY))
                path.addLine(to: point)
                currentY = point.y
              }
            }
            .stroke(
              AMMColor.cobalt,
              style: StrokeStyle(
                lineWidth: compact ? 2 : 2.5,
                lineCap: .square,
                lineJoin: .miter
              )
            )
          }
        }
      }
      .frame(height: compact ? 46 : 64)
      .accessibilityHidden(true)

      HStack(alignment: .top, spacing: 8) {
        Text(movement.window.startLabel)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(movement.window.endLabel)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
      .font(.system(size: compact ? 7 : 9, weight: .bold, design: .monospaced))
      .foregroundStyle(AMMColor.cobalt)
      .lineLimit(2)
      .minimumScaleFactor(0.72)
    }
    .padding(.top, compact ? 8 : 12)
    .overlay(alignment: .top) {
      Rectangle().fill(AMMColor.rule).frame(height: 1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "Thesis movement from \(movement.window.startLabel) to \(movement.window.endLabel). Current \(movement.currentLabel), \(movement.currentSupport) of \(movement.currentTotal) analysts agree."
    )
  }

  private func plottedPoints(width: CGFloat, height: CGFloat) -> [CGPoint] {
    guard !observations.isEmpty else { return [] }
    let start = parseDate(movement.window.startDate)
    let end = parseDate(movement.window.endDate)
    let startTime = start?.timeIntervalSince1970 ?? 0
    let duration = max(1, (end?.timeIntervalSince1970 ?? 1) - startTime)

    return observations.map { observation in
      let timestamp = parseDate(observation.date)?.timeIntervalSince1970 ?? startTime
      let fraction = max(0, min(1, (timestamp - startTime) / duration))
      let score = max(-2, min(2, observation.score))
      let y = height * (0.5 - CGFloat(score) * 0.17)
      return CGPoint(x: width * CGFloat(fraction), y: y)
    }
  }

  private func parseDate(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .iso8601)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.date(from: value)
  }
}
