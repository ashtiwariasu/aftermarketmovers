"use client";

import { useState, useRef, useEffect } from "react";
import type { DeskMessage } from "@/lib/desk";
import type { CouncilResult } from "@/lib/councilEngine";

const STANCE: Record<string, { mark: string; color: string }> = {
  align: { mark: "✓", color: "var(--pr-up)" },
  caution: { mark: "△", color: "#B8860B" },
  against: { mark: "✗", color: "var(--pr-down)" },
};

function CouncilCard({ m }: { m: DeskMessage }) {
  let result: CouncilResult | null = null;
  try {
    result = m.data ? (JSON.parse(m.data) as CouncilResult) : null;
  } catch {
    result = null;
  }
  if (!result) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-[92%] rounded-xl px-4 py-3 text-[14px]"
          style={{ background: "#FBF8F1", border: "2px solid var(--pr-ink)" }}
        >
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start w-full">
      <div
        className="w-full rounded-xl overflow-hidden"
        style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}
      >
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}
        >
          <span className="pp-mono text-[9.5px] uppercase tracking-[0.18em]">
            {`${result.seats.length} AI analysts reviewed`}
          </span>
          <span className="pp-disp font-extrabold text-[15px]" style={{ color: "var(--pr-lime)" }}>
            {result.vote}
          </span>
        </div>
        <div className="px-4 py-3 space-y-2">
          {result.seats.map((s) => {
            const st = STANCE[s.stance] ?? STANCE.caution;
            return (
              <div key={s.seat} className="flex gap-2.5 items-baseline text-[12.5px] leading-snug">
                <span
                  className="pp-mono text-[9.5px] uppercase tracking-[0.1em] w-[92px] shrink-0"
                  style={{ color: "var(--pr-faint)" }}
                >
                  {s.seat}
                </span>
                <span className="pp-mono w-4 shrink-0" style={{ color: st.color }}>
                  {st.mark}
                </span>
                <span style={{ color: "var(--pr-dim)" }}>{s.line}</span>
              </div>
            );
          })}
        </div>
        <div
          className="px-4 py-3 text-[13.5px] leading-relaxed"
          style={{ borderTop: "2px solid var(--pr-ink)", background: "#FBF8F1" }}
        >
          <span className="pp-mono text-[9.5px] uppercase tracking-[0.18em] block mb-1" style={{ color: "var(--pr-faint)" }}>
            AMM Desk · synthesis
          </span>
          {result.synthesis}
          {result.dissent && (
            <p className="mt-2 text-[12px]" style={{ color: "var(--pr-down)" }}>
              <span className="pp-mono text-[9.5px] uppercase tracking-[0.14em]">Strongest dissent · </span>
              {result.dissent}
            </p>
          )}
          {result.engine === "llmc3" && (
            <p className="mt-2 pp-mono text-[9.5px] uppercase tracking-[0.12em]" style={{ color: "var(--pr-faint)" }}>
              independent analyst review · agreement{" "}
              {result.consensus != null ? `${Math.round(result.consensus * 100)}%` : "—"}
              {result.winner ? ` · stage-1 winner ${result.winner}` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: DeskMessage }) {
  if (m.kind === "council") return <CouncilCard m={m} />;
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] rounded-xl px-4 py-2.5 text-[14px] font-medium"
          style={{ background: "var(--pr-blue)", color: "var(--pr-paper)" }}
        >
          {m.text}
        </div>
      </div>
    );
  }
  const isAlert = m.kind === "alert";
  const isNote = m.kind === "note";
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[92%] rounded-xl px-4 py-3 text-[14px] leading-relaxed"
        style={{
          background: isNote ? "var(--pr-card)" : "#FBF8F1",
          border: `2px solid ${isAlert ? "var(--pr-orange)" : "var(--pr-ink)"}`,
          borderLeftWidth: isAlert ? 5 : 2,
          whiteSpace: "pre-line",
        }}
      >
        {m.kind === "reply" && (
          <span
            className="pp-mono text-[9.5px] uppercase tracking-[0.18em] block mb-1"
            style={{ color: "var(--pr-faint)" }}
          >
            AMM Desk
          </span>
        )}
        {isAlert && (
          <span
            className="pp-mono text-[9.5px] uppercase tracking-[0.18em] block mb-1"
            style={{ color: "var(--pr-orange)" }}
          >
            Flag
          </span>
        )}
        {m.text}
      </div>
    </div>
  );
}

export default function DeskThread({
  initial,
  shiftLabel,
  ticker,
  placeholder,
}: {
  initial: DeskMessage[];
  shiftLabel: string;
  ticker?: string;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<DeskMessage[]>(initial);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    setMessages((m) => [
      ...m,
      { at: Date.now(), role: "user", kind: "question", text },
    ]);
    try {
      const res = await fetch("/api/desk/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...(ticker ? { ticker } : {}) }),
      });
      const data = await res.json();
      if (res.ok && data.messages) {
        const reply = data.messages.find(
          (m: DeskMessage) => m.role === "desk"
        );
        if (reply) setMessages((m) => [...m, reply]);
      }
    } catch {
      /* leave the question in the thread; the Desk will pick it up */
    }
    setSending(false);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        <div className="text-center py-2">
          <span className="pp-chip">{shiftLabel}</span>
        </div>
        {messages.map((m, i) => (
          <Bubble key={`${m.at}-${i}`} m={m} />
        ))}
        {sending && (
          <p className="pp-mono text-[11px] animate-pulse" style={{ color: "var(--pr-faint)" }}>
            Five AI analysts are reviewing your question — up to a minute…
          </p>
        )}
        <div ref={endRef} />
      </div>
      <div
        className="flex gap-2 items-center rounded-xl px-4 py-3 mt-2"
        style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={placeholder ?? "Ask AMM Desk…"}
          className="flex-1 outline-none text-[14px] bg-transparent"
          maxLength={500}
        />
        <button
          onClick={send}
          disabled={sending}
          className="h-8 w-8 rounded-full font-bold shrink-0"
          style={{ background: "var(--pr-orange)", color: "var(--pr-paper)" }}
          aria-label="Send"
        >
          ↑
        </button>
      </div>
      <p className="pp-mono text-[10px] mt-2" style={{ color: "var(--pr-faint)" }}>
        AMM Desk provides research, not advice · every answer is checked before you see it
      </p>
    </div>
  );
}
