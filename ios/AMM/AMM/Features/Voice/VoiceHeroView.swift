import SwiftUI

struct VoiceHeroView: View {
  let card: DeskCard
  @Environment(\.openURL) private var openURL
  @State private var voice: VoiceCoordinator
  @State private var chat: ThesisChatCoordinator
  @State private var isTextOpen = false
  @State private var pulse = false
  @FocusState private var textComposerFocused: Bool

  init(card: DeskCard, allowance: VoiceAllowance?) {
    self.card = card
    _voice = State(
      initialValue: VoiceCoordinator(
        ticker: card.ticker,
        allowance: allowance
      )
    )
    _chat = State(initialValue: ThesisChatCoordinator(ticker: card.ticker))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: 16) {
        voiceControl

        VStack(alignment: .leading, spacing: 5) {
          AMMMonoLabel(text: "Source-bound live voice", color: AMMColor.orange)
          Text(voice.statusTitle)
            .font(.system(size: 24, weight: .black, design: .rounded))
            .foregroundStyle(AMMColor.ink)
          Text(voice.statusDetail)
            .font(.system(size: 13))
            .foregroundStyle(AMMColor.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 4)
      }
      .padding(20)

      if voice.isActive || !voice.lastAnswer.isEmpty || !voice.verifiedFacts.isEmpty {
        Divider().overlay(AMMColor.rule)
        liveProgress
          .padding(20)
      }

      Divider().overlay(AMMColor.rule)
      textFallback

      Divider().overlay(AMMColor.rule)
      HStack(spacing: 8) {
        Image(systemName: "lock.shield")
        Text("Reads only \(card.ticker)’s selected, dated AMM sources")
        Spacer()
        if voice.quotaSeconds > 0 {
          Text(voice.clockText)
            .fontWeight(.bold)
            .foregroundStyle(voice.remainingSeconds < 120 ? AMMColor.orange : AMMColor.ink)
        } else if voice.needsUpgrade {
          Text("PRO / ULTRA")
            .fontWeight(.bold)
            .foregroundStyle(AMMColor.orange)
        }
      }
      .font(.system(size: 9, weight: .semibold, design: .monospaced))
      .tracking(0.7)
      .foregroundStyle(AMMColor.muted)
      .padding(.horizontal, 20)
      .padding(.vertical, 13)
    }
    .ammCardShadow(depth: 7)
    .task {
      guard !UIAccessibility.isReduceMotionEnabled else { return }
      withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) {
        pulse = true
      }
    }
    .onDisappear {
      Task { await voice.finish() }
    }
  }

  private var voiceControl: some View {
    ZStack {
      if voice.isActive {
        Circle()
          .stroke(AMMColor.orange.opacity(0.18), lineWidth: 2)
          .frame(width: pulse ? 86 : 72, height: pulse ? 86 : 72)
      }
      Circle()
        .fill(voice.isActive ? AMMColor.ink : AMMColor.card)
        .frame(width: 66, height: 66)
        .overlay {
          Circle().stroke(AMMColor.ink, lineWidth: 2)
        }
        .background {
          Circle()
            .fill(AMMColor.orange)
            .offset(x: 4, y: 5)
        }
      Button {
        Task {
          if voice.isActive {
            voice.toggleMicrophone()
          } else if voice.needsUpgrade {
            if let url = URL(string: "https://aftermarketmovers.com/#pricing") {
              openURL(url)
            }
          } else {
            await voice.start()
          }
        }
      } label: {
        Group {
          if voice.phase == .connecting || voice.phase == .requestingPermission {
            TriangleActivityView(size: 28)
          } else if voice.isMicrophoneMuted {
            Image(systemName: "mic.slash.fill")
              .font(.system(size: 22, weight: .bold))
          } else if voice.isActive {
            Image(systemName: "waveform")
              .font(.system(size: 23, weight: .bold))
              .symbolEffect(.variableColor.iterative, isActive: voice.phase == .speaking)
          } else {
            BrandTriangle()
              .fill(AMMColor.orange)
              .rotationEffect(.degrees(12))
              .frame(width: 23, height: 21)
          }
        }
        .foregroundStyle(voice.isActive ? .white : AMMColor.orange)
        .frame(width: 66, height: 66)
        .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .disabled(
        (!voice.isActive && !voice.canStart && !voice.needsUpgrade) ||
        (!voice.isActive && chat.isWorking)
      )
      .opacity(
        ((!voice.isActive && !voice.canStart && !voice.needsUpgrade) ||
         (!voice.isActive && chat.isWorking)) ? 0.45 : 1
      )
      .accessibilityLabel(
        voice.isActive
          ? "Pause microphone"
          : voice.needsUpgrade
            ? "See AMM voice plans"
            : voice.dailyAllowanceUsed
              ? "Daily voice allowance used"
              : "Start live thesis voice"
      )
      .accessibilityHint("Uses only the selected dated AMM company file")
    }
    .frame(width: 88, height: 88)
  }

  private var textFallback: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.snappy(duration: 0.28)) {
          isTextOpen.toggle()
        }
        if isTextOpen {
          Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(220))
            textComposerFocused = true
          }
        }
      } label: {
        HStack(spacing: 12) {
          ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(AMMColor.paper)
              .frame(width: 42, height: 42)
            Image(systemName: "text.cursor")
              .font(.system(size: 16, weight: .bold))
              .foregroundStyle(AMMColor.cobalt)
          }
          VStack(alignment: .leading, spacing: 3) {
            AMMMonoLabel(text: "Or type", color: AMMColor.cobalt)
            Text(chat.messages.isEmpty ? "Ask a source-bound question" : "Continue this company-file thread")
              .font(.system(size: 14, weight: .bold, design: .rounded))
              .foregroundStyle(AMMColor.ink)
          }
          Spacer()
          if chat.isWorking {
            TriangleActivityView(size: 22)
          } else {
            Image(systemName: isTextOpen ? "chevron.up" : "chevron.down")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(AMMColor.muted)
          }
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 20)
        .padding(.vertical, 13)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(isTextOpen ? "Close typed questions" : "Open typed questions")
      .accessibilityHint("Answers use the same selected dated company file as live voice")

      if isTextOpen {
        VStack(alignment: .leading, spacing: 15) {
          if chat.messages.isEmpty {
            promptSuggestions
          } else {
            chatHistory
          }

          if chat.isWorking || chat.statusDetail != nil {
            chatStatus
          }

          chatComposer
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
  }

  private var promptSuggestions: some View {
    VStack(alignment: .leading, spacing: 9) {
      Text("Start with the decision-relevant part.")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(AMMColor.muted)
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          suggestion("What supports this thesis?")
          suggestion("What could break it?")
          suggestion("What changed in the admitted evidence?")
        }
      }
      .scrollIndicators(.hidden)
    }
  }

  private func suggestion(_ question: String) -> some View {
    Button {
      chat.send(question)
    } label: {
      Text(question)
        .font(.system(size: 11, weight: .bold, design: .rounded))
        .foregroundStyle(AMMColor.ink)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(AMMColor.paper, in: Capsule())
        .overlay(Capsule().stroke(AMMColor.rule, lineWidth: 1))
    }
    .buttonStyle(.plain)
    .disabled(voice.isActive || chat.isWorking)
  }

  private var chatHistory: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        AMMMonoLabel(text: "Company-file thread", color: AMMColor.orange)
        Spacer()
        Button("New") {
          chat.newSession()
          textComposerFocused = true
        }
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .foregroundStyle(AMMColor.cobalt)
        .buttonStyle(.plain)
        .disabled(chat.isWorking)
        .accessibilityLabel("Start a new company-file thread")
      }

      ForEach(chat.messages.suffix(6)) { message in
        ChatMessageView(message: message)
      }
    }
  }

  private var chatStatus: some View {
    HStack(alignment: .top, spacing: 10) {
      if chat.isWorking {
        TriangleActivityView(size: 21)
      } else {
        Image(systemName: statusIcon)
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(statusColor)
          .frame(width: 21, height: 21)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(chat.statusTitle)
          .font(.system(size: 12, weight: .bold, design: .rounded))
          .foregroundStyle(AMMColor.ink)
        if let detail = chat.statusDetail {
          Text(detail)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(AMMColor.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer()
      if case .failed = chat.phase {
        Button("Retry") {
          chat.retryLastQuestion()
        }
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .foregroundStyle(AMMColor.cobalt)
        .buttonStyle(.plain)
      }
    }
    .padding(12)
    .background(AMMColor.paper.opacity(0.72), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .combine)
  }

  private var chatComposer: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField(
        "Ask about \(card.ticker)’s thesis, evidence, or risk…",
        text: Binding(
          get: { chat.draft },
          set: { chat.draft = $0 }
        ),
        axis: .vertical
      )
      .font(.system(size: 15, weight: .medium, design: .rounded))
      .lineLimit(1...5)
      .focused($textComposerFocused)
      .submitLabel(.send)
      .onSubmit {
        guard !chat.draft.contains("\n") else { return }
        chat.send()
      }
      .disabled(voice.isActive || chat.isWorking)
      .accessibilityLabel("Question for the \(card.ticker) company file")

      Button {
        if chat.canCancel {
          chat.stop()
        } else {
          chat.send()
        }
      } label: {
        ZStack {
          Circle()
            .fill(chat.isWorking ? AMMColor.ink : AMMColor.orange)
            .frame(width: 42, height: 42)
          if chat.canCancel {
            Image(systemName: "stop.fill")
              .font(.system(size: 12, weight: .black))
              .foregroundStyle(.white)
          } else if chat.isWorking {
            TriangleActivityView(size: 22)
          } else {
            BrandTriangle()
              .fill(.white)
              .rotationEffect(.degrees(12))
              .frame(width: 16, height: 15)
          }
        }
      }
      .buttonStyle(.plain)
      .disabled(
        voice.isActive ||
        (chat.isWorking && !chat.canCancel) ||
        (!chat.isWorking && chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      )
      .opacity(
        voice.isActive ||
        (chat.isWorking && !chat.canCancel) ||
        (!chat.isWorking && chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          ? 0.45
          : 1
      )
      .accessibilityLabel(
        chat.canCancel
          ? "Stop question"
          : chat.isWorking
            ? "Saving verified answer"
            : "Send question"
      )
    }
    .padding(10)
    .background(AMMColor.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(textComposerFocused ? AMMColor.cobalt : AMMColor.rule, lineWidth: textComposerFocused ? 2 : 1)
    }
    .overlay(alignment: .topLeading) {
      if voice.isActive {
        Text("End the voice conversation to type.")
          .font(.system(size: 9, weight: .bold, design: .monospaced))
          .foregroundStyle(AMMColor.orange)
          .offset(y: -15)
      }
    }
  }

  private var statusIcon: String {
    switch chat.phase {
    case .complete:
      "checkmark.seal.fill"
    case .quota:
      "gauge"
    case .failed:
      "exclamationmark.triangle.fill"
    default:
      "lock.shield.fill"
    }
  }

  private var statusColor: Color {
    switch chat.phase {
    case .complete:
      AMMColor.positive
    case .quota, .failed:
      AMMColor.orange
    default:
      AMMColor.cobalt
    }
  }

  private var liveProgress: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 8) {
        ProgressChip(
          title: "Listen",
          isActive: voice.phase == .listening || voice.phase == .paused,
          isComplete: voice.phase == .retrieving || voice.phase == .verifying || voice.phase == .speaking
        )
        ProgressChip(
          title: "Retrieve",
          isActive: voice.phase == .retrieving,
          isComplete: voice.phase == .verifying || voice.phase == .speaking
        )
        ProgressChip(
          title: "Verify",
          isActive: voice.phase == .verifying,
          isComplete: voice.phase == .speaking
        )
        ProgressChip(
          title: "Answer",
          isActive: voice.phase == .speaking,
          isComplete: false
        )
      }

      if !voice.lastAnswer.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          AMMMonoLabel(text: "Verified answer", color: AMMColor.orange)
          if !voice.lastQuestion.isEmpty {
            Text(voice.lastQuestion)
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(AMMColor.muted)
              .lineLimit(2)
          }
          Text(voice.lastAnswer)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(AMMColor.ink)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(AMMColor.paper.opacity(0.68))
        .overlay(alignment: .leading) {
          Rectangle().fill(AMMColor.orange).frame(width: 3)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }

      if !voice.verifiedFacts.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          AMMMonoLabel(text: "Verified in this answer", color: AMMColor.positive)
          ForEach(voice.verifiedFacts.prefix(4)) { fact in
            if let url = fact.url {
              Link(destination: url) {
                verifiedFactRow(fact)
              }
            } else {
              verifiedFactRow(fact)
            }
          }
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
      }

      if voice.isActive {
        Button {
          Task { await voice.finish() }
        } label: {
          Label("End conversation", systemImage: "stop.fill")
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundStyle(AMMColor.negative)
        }
        .buttonStyle(.plain)
      } else if voice.needsUpgrade {
        Button {
          if let url = URL(string: "https://aftermarketmovers.com/#pricing") {
            openURL(url)
          }
        } label: {
          Label("See live voice plans", systemImage: "arrow.up.right")
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundStyle(AMMColor.cobalt)
        }
        .buttonStyle(.plain)
      }
    }
  }

  private func verifiedFactRow(_ fact: VoiceCoordinator.VerifiedFact) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "checkmark.seal.fill")
        .foregroundStyle(AMMColor.positive)
      Text(fact.label)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(AMMColor.ink)
        .lineLimit(2)
      Spacer()
      if fact.url != nil {
        Image(systemName: "arrow.up.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(AMMColor.cobalt)
      }
    }
  }
}

private struct ChatMessageView: View {
  let message: ThesisChatCoordinator.Message

  private var isMember: Bool {
    message.role == .member
  }

  private var formattedText: AttributedString {
    (
      try? AttributedString(
        markdown: message.text,
        options: .init(interpretedSyntax: .full)
      )
    ) ?? AttributedString(message.text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      AMMMonoLabel(
        text: isMember ? "You" : "Verified answer",
        color: isMember ? AMMColor.cobalt : AMMColor.orange
      )
      Text(formattedText)
        .font(.system(size: 14, weight: isMember ? .medium : .semibold, design: .rounded))
        .foregroundStyle(AMMColor.ink)
        .tint(AMMColor.cobalt)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(13)
    .background(
      isMember ? AMMColor.paper.opacity(0.72) : AMMColor.card,
      in: RoundedRectangle(cornerRadius: 14, style: .continuous)
    )
    .overlay(alignment: .leading) {
      if !isMember {
        Rectangle()
          .fill(AMMColor.orange)
          .frame(width: 3)
      }
    }
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(isMember ? Color.clear : AMMColor.rule, lineWidth: 1)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(isMember ? "Your question" : "Verified AMM answer"): \(message.text)"
    )
  }
}

private struct ProgressChip: View {
  let title: String
  let isActive: Bool
  let isComplete: Bool

  var body: some View {
    HStack(spacing: 5) {
      if isComplete {
        Image(systemName: "checkmark")
      } else if isActive {
        BrandTriangle()
          .fill(AMMColor.orange)
          .rotationEffect(.degrees(12))
          .frame(width: 8, height: 8)
      }
      Text(title.uppercased())
    }
    .font(.system(size: 8, weight: .bold, design: .monospaced))
    .foregroundStyle(isActive ? AMMColor.orange : isComplete ? AMMColor.positive : AMMColor.muted)
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(
      (isActive ? AMMColor.orange : isComplete ? AMMColor.positive : AMMColor.muted)
        .opacity(0.08),
      in: Capsule()
    )
    .frame(maxWidth: .infinity)
  }
}
