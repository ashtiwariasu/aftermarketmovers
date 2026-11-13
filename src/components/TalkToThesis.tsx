"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Tier } from "@/lib/tiers";
import { TIERS } from "@/lib/tiers";
import { VOICE_TOOL_NAME } from "@/lib/realtimeVoice";

type VoiceState = "idle" | "connecting" | "live" | "ending" | "ended" | "error";

interface TranscriptEntry {
  role: "member" | "desk";
  text: string;
  written?: string;
}

interface RealtimeOutputItem {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function BrandedTriangle({ active = false }: { active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-0 w-0 border-l-[9px] border-r-[9px] border-b-[17px] border-l-transparent border-r-transparent ${
        active ? "animate-pulse" : ""
      }`}
      style={{ borderBottomColor: "var(--pr-orange)", transform: "rotate(12deg)" }}
    />
  );
}

export default function TalkToThesis({
  ticker,
  tier,
}: {
  ticker: string;
  tier: Tier;
}) {
  const cap = TIERS[tier].voiceSecondsPerDay;
  const [state, setState] = useState<VoiceState>("idle");
  const [remaining, setRemaining] = useState(cap);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef("");
  const processedCalls = useRef(new Set<string>());
  const endingRef = useRef(false);

  const end = useCallback(async (reason: "member" | "connection" = "member") => {
    if (endingRef.current) return;
    endingRef.current = true;
    setState("ending");
    const sessionId = sessionRef.current;
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    if (sessionId) {
      await fetch("/api/desk/voice/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, finish: true, reason }),
        keepalive: true,
      }).catch(() => null);
    }
    sessionRef.current = "";
    setState("ended");
    endingRef.current = false;
  }, []);

  const runFileTool = useCallback(async (item: RealtimeOutputItem) => {
    const callId = item.call_id ?? "";
    if (!callId || processedCalls.current.has(callId) || item.name !== VOICE_TOOL_NAME) return;
    processedCalls.current.add(callId);
    let question = "";
    try {
      question = String(JSON.parse(item.arguments ?? "{}").question ?? "").trim();
    } catch {
      question = "";
    }
    const sessionId = sessionRef.current;
    if (!sessionId || !question) return;
    if (question) {
      const memberEntry: TranscriptEntry = { role: "member", text: question };
      setTranscript((current) => [...current, memberEntry].slice(-12));
    }

    const response = await fetch("/api/desk/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question }),
    });
    const payload = await response.json().catch(() => ({})) as {
      answer?: string;
      spokenAnswer?: string;
      error?: string;
      allowance?: { remainingSeconds?: number };
    };
    const spokenAnswer = payload.spokenAnswer ||
      "AMM could not release a dated, source-bound answer. Try a narrower question.";
    if (typeof payload.allowance?.remainingSeconds === "number") {
      setRemaining(payload.allowance.remainingSeconds);
    }
    const deskEntry: TranscriptEntry = {
      role: "desk",
      text: spokenAnswer,
      ...(payload.answer ? { written: payload.answer } : {}),
    };
    setTranscript((current) => [...current, deskEntry].slice(-12));
    dcRef.current?.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ spokenAnswer }),
      },
    }));
    dcRef.current?.send(JSON.stringify({ type: "response.create" }));
    if (response.status === 429) {
      setNotice(payload.error ?? "Today’s voice allowance has been used.");
      await end();
    }
  }, [end]);

  const handleEvent = useCallback((raw: MessageEvent<string>) => {
    let event: {
      type?: string;
      transcript?: string;
      response?: { output?: RealtimeOutputItem[] };
    };
    try {
      event = JSON.parse(raw.data);
    } catch {
      return;
    }
    if (event.type === "response.done") {
      for (const item of event.response?.output ?? []) {
        if (item.type === "function_call") void runFileTool(item);
      }
    }
  }, [runFileTool]);

  const start = useCallback(async () => {
    if (tier === "free") {
      setNotice("Live thesis voice is included with an active AMM subscription.");
      return;
    }
    if (configured === false) {
      setNotice("Live thesis voice is awaiting its secure Realtime connection.");
      return;
    }
    setState("connecting");
    setNotice("Allow microphone access when your browser asks.");
    setTranscript([]);
    processedCalls.current.clear();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setNotice("");
      streamRef.current = stream;
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      pc.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
        void remoteAudio.play().catch(() => null);
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState) && !endingRef.current) {
          setNotice("The voice connection ended.");
          void end("connection");
        }
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = handleEvent;
      dc.onopen = () => {
        setState("live");
        setExpanded(true);
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text:
                `Give me the current ${ticker} thesis in plain English: what changed, the decisive evidence, ` +
                "the principal disagreement, and what would change the read.",
            }],
          },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch(`/api/desk/voice/session?ticker=${encodeURIComponent(ticker)}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Live voice could not start." }));
        throw new Error(payload.error);
      }
      const sessionId = response.headers.get("X-AMM-Voice-Session") ?? "";
      const remainingHeader = Number(response.headers.get("X-AMM-Voice-Remaining"));
      if (!sessionId) throw new Error("Voice session was not established.");
      sessionRef.current = sessionId;
      if (Number.isFinite(remainingHeader)) setRemaining(remainingHeader);
      await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
    } catch (error) {
      pcRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setState("error");
      const message = error instanceof Error ? error.message : "";
      setNotice(
        message.toLowerCase().includes("permission") || message.toLowerCase().includes("denied")
          ? "Microphone access is required. Allow it in your browser’s site settings, then try again."
          : message || "Live voice could not start.",
      );
    }
  }, [configured, end, handleEvent, ticker, tier]);

  useEffect(() => {
    let current = true;
    void fetch(`/api/desk/voice/status?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{
          configured?: boolean;
          allowance?: { remainingSeconds?: number; reason?: string };
        }>;
      })
      .then((payload) => {
        if (!current || !payload) return;
        setConfigured(Boolean(payload.configured));
        if (typeof payload.allowance?.remainingSeconds === "number") {
          setRemaining(payload.allowance.remainingSeconds);
        }
        if (payload.allowance?.reason === "already_active") {
          setNotice("This AMM Desk already has an active voice conversation.");
        } else if (payload.allowance?.reason === "quota_exhausted") {
          setNotice("Today’s live thesis voice allowance has been used.");
        }
      })
      .catch(() => {
        if (current) setConfigured(false);
      });
    return () => {
      current = false;
    };
  }, [ticker]);

  useEffect(() => {
    if (state !== "live") return;
    const visibleTimer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          setNotice("Today’s live thesis voice allowance has been used.");
          void end();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    const heartbeat = window.setInterval(async () => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      const response = await fetch("/api/desk/voice/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => null);
      if (!response?.ok) {
        setNotice("The metered voice session ended.");
        await end("connection");
        return;
      }
      const payload = await response.json() as { allowance?: { remainingSeconds?: number } };
      if (typeof payload.allowance?.remainingSeconds === "number") {
        setRemaining(payload.allowance.remainingSeconds);
      }
    }, 10_000);
    return () => {
      window.clearInterval(visibleTimer);
      window.clearInterval(heartbeat);
    };
  }, [end, state]);

  useEffect(() => () => {
    const sessionId = sessionRef.current;
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (sessionId) {
      void fetch("/api/desk/voice/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, finish: true }),
        keepalive: true,
      });
    }
  }, []);

  const live = state === "live";
  return (
    <section className="pp-card pp-shadow mt-9 overflow-hidden" aria-labelledby="talk-thesis-title">
      <div className="p-5 sm:p-6 flex items-center justify-between gap-5 flex-wrap">
        <div className="flex items-center gap-4">
          <span
            className="w-12 h-12 rounded-full grid place-items-center shrink-0"
            style={{ border: "2px solid var(--pr-ink)", boxShadow: "3px 3px 0 var(--pr-orange)" }}
          >
            <BrandedTriangle active={live || state === "connecting"} />
          </span>
          <div>
            <p className="pp-mono text-[9px] uppercase tracking-[.2em]" style={{ color: "var(--pr-orange)" }}>
              Source-bound live voice
            </p>
            <h2 id="talk-thesis-title" className="pp-disp text-xl sm:text-2xl font-extrabold">
              Talk to the {ticker} thesis
            </h2>
            <p className="text-[13px] mt-1" style={{ color: "var(--pr-dim)" }}>
              Ask about the thesis, evidence, risk or what would change the read.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {tier !== "free" && (
            <span className="pp-mono text-[10px] uppercase tracking-[.12em]" style={{ color: live ? "var(--pr-up)" : "var(--pr-dim)" }}>
              {live ? `${clock(remaining)} left today` : `${Math.round(cap / 60)} min daily`}
            </span>
          )}
          {live ? (
            <button type="button" className="pp-btn pp-btn-orange px-5 py-3 text-[13px]" onClick={() => void end()}>
              End conversation
            </button>
          ) : (
            <button
              type="button"
              className="pp-btn pp-btn-dark px-5 py-3 text-[13px]"
              onClick={() => void start()}
              disabled={
                state === "connecting" ||
                state === "ending" ||
                configured === null ||
                (tier !== "free" && configured === false)
              }
            >
              {state === "connecting"
                ? "Connecting…"
                : tier === "free"
                  ? "Unlock with Pro"
                  : configured === false
                    ? "Voice setup pending"
                    : "Talk to thesis"}
            </button>
          )}
        </div>
      </div>

      {(notice || transcript.length > 0) && (
        <div style={{ borderTop: "1.5px solid var(--pr-ink)" }}>
          {notice && (
            <p className="px-5 sm:px-6 py-3 text-[12px]" style={{ background: "rgba(255,75,35,.07)", color: "var(--pr-down)" }}>
              {notice}
            </p>
          )}
          {transcript.length > 0 && (
            <>
              <button
                type="button"
                className="w-full px-5 sm:px-6 py-3 flex items-center justify-between pp-mono text-[9px] uppercase tracking-[.16em]"
                onClick={() => setExpanded((value) => !value)}
              >
                <span>Dated answer record · {transcript.filter((entry) => entry.role === "desk").length}</span>
                <span>{expanded ? "−" : "+"}</span>
              </button>
              {expanded && (
                <div className="px-5 sm:px-6 pb-6 space-y-4 max-h-[420px] overflow-y-auto" aria-live="polite">
                  {transcript.map((entry, index) => (
                    <article
                      key={`${entry.role}-${index}`}
                      className="p-4 rounded-xl"
                      style={{
                        background: entry.role === "member" ? "rgba(45,78,245,.06)" : "var(--pr-paper)",
                        border: "1px solid rgba(22,21,15,.16)",
                      }}
                    >
                      <p className="pp-mono text-[8px] uppercase tracking-[.18em] mb-2" style={{ color: entry.role === "member" ? "var(--pr-blue)" : "var(--pr-orange)" }}>
                        {entry.role === "member" ? "You" : "AMM file"}
                      </p>
                      {entry.written ? (
                        <div className="prose prose-sm max-w-none text-[13px] leading-relaxed">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.written}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="text-[13px] leading-relaxed">{entry.text}</p>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div
        className="px-5 sm:px-6 py-3 pp-mono text-[8px] uppercase tracking-[.13em]"
        style={{ borderTop: "1px solid rgba(22,21,15,.14)", color: "var(--pr-faint)" }}
      >
        Reads only this company’s selected, dated AMM sources · no open-web answers · no raw audio stored
      </div>
    </section>
  );
}
