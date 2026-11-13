"use client";

/**
 * AMM Desk chat — answers stay inside the already-researched company file and
 * the intent-matched, dated sources selected for the member's question.
 */

import { useEffect, useRef, useState } from "react";
import Md from "@/components/Md";
import UsageMeter from "@/components/UsageMeter";
import AmmFox from "@/components/AmmFox";

export interface SittingTranscript {
  lead: string;
  chair?: string;
  draft: string;
  audits: Array<{ role: string; model: string; text: string }>;
}

export interface RoomMsg {
  role: "user" | "assistant";
  content: string;
  attachments?: { filename: string }[];
  transcript?: SittingTranscript;
}

interface Props {
  ticker: string;
  userEmail: string;
  wsUrl: string; // legacy (llmc3 rooms) — unused by the audited room
  initialSessionId: string | null;
  history: RoomMsg[];
  intro: string;
  contextNote: string; // legacy grounding prefix — unused by the audited room
  /** Company-file context: curated document_ids (empty = whole folder). */
  libraryContext: { folder_ids: string[]; document_ids: string[]; chat_ids: string[] };
  /** Composer footer line, e.g. "■ 9 of 12 file sources in context". */
  fileStatus: string;
  /** File a report card into the company file; resolves true on success. */
  onFileReport: (name: string, content: string) => Promise<boolean>;
  /** Notify the workspace of session creation/titling (multi-session rooms). */
  onSessionEvent?: (sessionId: string, title?: string) => void;
  /** One-machine attach: upload into the company file. */
  onAttachFile?: (file: File) => Promise<{ ok: boolean; name?: string }>;
  /** Stock-page treatment: keep the full audited engine, simplify its chrome. */
  compact?: boolean;
}

const CTX_OPEN = "[desk file]";
const CTX_CLOSE = "[member question]";

/** Strip the grounding prefix legacy sessions injected on their first message. */
export function displayContent(content: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(CTX_CLOSE);
  if (lower.startsWith(CTX_OPEN) && idx >= 0) {
    return content.slice(idx + CTX_CLOSE.length).trimStart();
  }
  return content;
}

/** Report title: first markdown heading, else the question, else a fallback. */
function reportTitle(content: string, question?: string): string {
  const h = content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (h) return h.replace(/[#*_`]/g, "").slice(0, 80);
  if (question) return question.slice(0, 80);
  return "AMM Desk answer";
}

const AUDIT_LABELS: Record<string, string> = {
  "THE FINANCIAL MECHANISM SEAT": "The financial mechanism",
  "THE NUMBERS SEAT": "The numbers check",
  "THE RISK SEAT": "The other side",
  "THE CONTEXT SEAT": "The wider context",
  "THE EVIDENCE MARSHAL": "The source audit",
};

/** Collapsed audit trail under a finished answer. */
function TranscriptChip({ t }: { t: SittingTranscript }) {
  const [open, setOpen] = useState(false);
  if (!t.chair && !t.draft && t.audits.length === 0) {
    return (
      <div className="mt-2">
        <span
          className="pp-mono text-[9.5px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-full inline-flex"
          style={{
            border: "1.5px solid var(--pr-ink)",
            background: "var(--pr-card)",
            color: "var(--pr-dim)",
          }}
        >
          Grounded in your AMM file · dated sources
        </span>
      </div>
    );
  }
  const returnedModels = Math.min(4, t.audits.length + 2);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="pp-mono text-[9.5px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-full"
        style={{
          border: "1.5px solid var(--pr-ink)",
          background: open ? "var(--pr-ink)" : "var(--pr-card)",
          color: open ? "var(--pr-paper)" : "var(--pr-dim)",
        }}
      >
        {open ? "▾" : "▸"} {t.chair
          ? `${returnedModels === 4 ? "four analysts" : `${returnedModels}/4 analysts`} · how this answer was checked`
          : `how this answer was checked · first read + ${t.audits.length} review${t.audits.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded-xl px-4 py-3" style={{ border: "2px dashed rgba(22,21,15,.3)", background: "#FBF8F1" }}>
            <span className="pp-mono text-[9px] uppercase tracking-[0.16em] block mb-1.5" style={{ color: "var(--pr-faint)" }}>
              {t.chair ? "Lead financial read — before chair synthesis" : "Working draft — the first read, before audit"}
            </span>
            <div style={{ opacity: 0.75 }}>
              <Md text={t.draft} />
            </div>
          </div>
          {t.audits.map((a, i) => (
            <div key={i} className="rounded-xl px-4 py-3" style={{ border: "2px dashed rgba(22,21,15,.3)", background: "#FBF8F1" }}>
              <span className="pp-mono text-[9px] uppercase tracking-[0.16em] block mb-1.5" style={{ color: "var(--pr-orange)" }}>
                {AUDIT_LABELS[a.role] ?? a.role}
              </span>
              <div style={{ opacity: 0.75 }}>
                <Md text={a.text} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- main room ----------

export default function CouncilRoom({
  ticker,
  initialSessionId,
  history,
  intro,
  libraryContext,
  fileStatus,
  onFileReport,
  onSessionEvent,
  onAttachFile,
  compact = false,
}: Props) {
  const [messages, setMessages] = useState<RoomMsg[]>(history);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [notesDone, setNotesDone] = useState(false);
  const [answer, setAnswer] = useState("");
  const [attachNote, setAttachNote] = useState("");
  const [sitOpen, setSitOpen] = useState<Record<number, boolean>>({});
  const [filed, setFiled] = useState<Set<string>>(new Set());
  const [filing, setFiling] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(initialSessionId);
  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming, lines.length, answer]);

  useEffect(() => {
    if (notesRef.current) notesRef.current.scrollTop = notesRef.current.scrollHeight;
  }, [notes]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function persistSession(sid: string, title?: string) {
    if (onSessionEvent) {
      onSessionEvent(sid, title);
      return;
    }
    fetch("/api/desk/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, sessionId: sid, ...(title ? { title } : {}) }),
    }).catch(() => {});
  }

  function resetLive() {
    setStreaming(false);
    setLines([]);
    setNotes("");
    setNotesDone(false);
    setAnswer("");
    answerRef.current = "";
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    const isFirstTurn = sessionIdRef.current === null;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setStreaming(true);
    setLines([]);
    setNotes("");
    setNotesDone(false);
    setAnswer("");
    answerRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/desk/sitting/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          question: text,
          sessionId: sessionIdRef.current ?? undefined,
          documentIds: libraryContext.document_ids.length > 0 ? libraryContext.document_ids : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        setMessages((m) => [
          ...m,
          { role: "assistant", content: err?.error ?? "AMM Desk couldn't answer. Try again in a moment." },
        ]);
        resetLive();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const raw = frame.trim();
          if (!raw.startsWith("data:")) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(raw.slice(5).trim());
          } catch {
            continue;
          }
          switch (ev.type) {
            case "line":
              if (typeof ev.text === "string") {
                setLines((prev) => [...prev, ev.text as string]);
                // The first line after the draft closes the notes pane.
                if ((ev.text as string).startsWith("First read formed")) setNotesDone(true);
              }
              break;
            case "notes":
              if (typeof ev.text === "string") setNotes((prev) => prev + (ev.text as string));
              break;
            case "answer":
              if (typeof ev.text === "string") {
                setNotesDone(true);
                answerRef.current += ev.text as string;
                setAnswer(answerRef.current);
              }
              break;
            case "wall": {
              const wall = ev.wall as { label: string; price: string; blurb: string } | null;
              setMessages((m) => [
                ...m,
                {
                  role: "assistant",
                  content:
                    `AMM Desk has used all research questions this month — ${ev.used} of ${ev.cap} used.` +
                    (wall ? `\n\n**${wall.label}** restores it instantly: ${wall.blurb} · ${wall.price}.` : "\n\nYour meter resets at the start of next month."),
                },
              ]);
              window.dispatchEvent(new Event("desk-usage-changed"));
              finished = true;
              break;
            }
            case "done": {
              const transcript = ev.transcript as SittingTranscript | undefined;
              const sid = typeof ev.sessionId === "string" ? ev.sessionId : null;
              if (sid) {
                sessionIdRef.current = sid;
                persistSession(sid, isFirstTurn ? text.slice(0, 60) : undefined);
              }
              setMessages((m) => [
                ...m,
                { role: "assistant", content: (ev.answer as string) ?? answerRef.current, transcript },
              ]);
              window.dispatchEvent(new Event("desk-usage-changed"));
              finished = true;
              break;
            }
            case "error":
              setMessages((m) => [
                ...m,
                { role: "assistant", content: (ev.text as string) ?? "AMM Desk hit an error. Try again." },
              ]);
              finished = true;
              break;
          }
          if (finished) break;
        }
        if (finished) break;
      }
      if (!finished && answerRef.current) {
        // Stream ended without a done frame — keep what the chair wrote.
        setMessages((m) => [...m, { role: "assistant", content: answerRef.current }]);
      }
    } catch {
      if (answerRef.current) {
        setMessages((m) => [...m, { role: "assistant", content: answerRef.current + "\n\n_(question interrupted)_" }]);
      } else if (abortRef.current === controller && controller.signal.aborted) {
        setMessages((m) => [...m, { role: "assistant", content: "_Question stopped._" }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: "Couldn't reach AMM Desk. Check your connection and try again." }]);
      }
    } finally {
      resetLive();
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function onPickFiles(list: FileList | null) {
    if (!list || !onAttachFile) return;
    for (const f of Array.from(list).slice(0, 3)) {
      setAttachNote(`Filing ${f.name} into the company file…`);
      const res = await onAttachFile(f);
      setAttachNote(res.ok ? `▤ ${f.name} filed and checked in.` : `Couldn't file ${f.name} — try again.`);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    setTimeout(() => setAttachNote(""), 4000);
  }

  // ---- sittings: group the transcript into question → report units ----
  const pre: RoomMsg[] = [];
  const sittings: Array<{ question: RoomMsg; answers: RoomMsg[] }> = [];
  for (const m of messages) {
    if (m.role === "user") sittings.push({ question: m, answers: [] });
    else if (sittings.length === 0) pre.push(m);
    else sittings[sittings.length - 1].answers.push(m);
  }
  const isOpen = (n: number) => sitOpen[n] ?? n === sittings.length - 1;

  async function fileReport(key: string, question: string | undefined, m: RoomMsg) {
    if (filed.has(key) || filing) return;
    setFiling(key);
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const ok = await onFileReport(`Report — ${reportTitle(m.content, question)} · ${date}`, m.content);
    setFiling(null);
    if (ok) setFiled((prev) => new Set(prev).add(key));
  }

  function renderUser(m: RoomMsg, key: string) {
    return (
      <div key={key} className="flex justify-end">
        <div className="max-w-[85%] rounded-xl px-4 py-2.5 text-[14px] font-medium" style={{ background: "var(--pr-blue)", color: "var(--pr-paper)" }}>
          {displayContent(m.content)}
        </div>
      </div>
    );
  }

  function renderReport(m: RoomMsg, key: string, question?: string) {
    const isFiled = filed.has(key);
    const researched = Boolean(m.transcript);
    const singleModel = Boolean(
      m.transcript &&
      !m.transcript.chair &&
      !m.transcript.draft &&
      m.transcript.audits.length === 0
    );
    return (
      <div key={key} className="flex justify-start">
        <div className="max-w-[95%] w-full">
          <div className="rounded-xl overflow-hidden" style={{ background: "var(--pr-card)", border: "2px solid var(--pr-ink)", boxShadow: researched ? "4px 4px 0 var(--pr-ink)" : undefined }}>
            {researched ? (
              <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-2" style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}>
                <span className="pp-mono text-[9.5px] uppercase tracking-[0.18em]">
                  AMM Desk answer · {reportTitle(m.content, question).slice(0, 44)}
                </span>
                <span className="pp-mono text-[9px]" style={{ color: "var(--pr-lime)" }}>
                  {singleModel
                    ? "AMM file · dated sources"
                    : m.transcript!.chair
                    ? `${Math.min(4, m.transcript!.audits.length + 2)}/4 models · chair synthesis`
                    : `audited draft · ${m.transcript!.audits.length} checks`}
                </span>
              </div>
            ) : (
              <span className="pp-mono text-[9.5px] uppercase tracking-[0.18em] block px-4 pt-3" style={{ color: "var(--pr-faint)" }}>
                AMM Desk
              </span>
            )}
            <div className="px-4 py-3">
              <Md text={m.content} />
            </div>
            {researched && (
              <div className="flex items-center gap-2 flex-wrap px-4 py-2" style={{ borderTop: "2px solid var(--pr-ink)", background: "#FBF8F1" }}>
                <button
                  onClick={() => fileReport(key, question, m)}
                  disabled={isFiled || filing === key}
                  className="pp-mono text-[9px] uppercase tracking-[0.12em] px-2.5 py-1 rounded-full"
                  style={{
                    border: "1.5px solid var(--pr-ink)",
                    background: isFiled ? "var(--pr-lime)" : "var(--pr-orange)",
                    color: isFiled ? "var(--pr-ink)" : "var(--pr-paper)",
                  }}
                >
                  {isFiled ? "✓ filed to the company file" : filing === key ? "filing…" : "▤ file this report"}
                </button>
              </div>
            )}
          </div>
          {m.transcript && <TranscriptChip t={m.transcript} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="space-y-3 pb-4">
        {/* session header */}
        {!compact && <div className="flex items-center gap-2 flex-wrap py-2">
          <span className="pp-chip">{ticker} · AMM DESK</span>
          {sittings.length > 0 && (
            <span className="pp-mono text-[9.5px]" style={{ color: "var(--pr-faint)" }}>
              SESSION · {sittings.length} QUESTION{sittings.length === 1 ? "" : "S"}
            </span>
          )}
          {sittings.length > 1 && (
            <span className="ml-auto flex gap-1.5 items-center">
              {sittings.map((_, n) => (
                <button
                  key={n}
                  onClick={() => {
                    setSitOpen((p) => ({ ...p, [n]: true }));
                    document.getElementById(`sit-${ticker}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="pp-mono text-[9px] px-1.5 py-0.5 rounded"
                  style={{
                    border: "1.5px solid var(--pr-ink)",
                    background: n === sittings.length - 1 ? "var(--pr-ink)" : "var(--pr-card)",
                    color: n === sittings.length - 1 ? "var(--pr-paper)" : "var(--pr-dim)",
                  }}
                >
                  {String(n + 1).padStart(2, "0")}
                </button>
              ))}
            </span>
          )}
        </div>}

        {/* intro */}
        {!compact && <div className="flex justify-start">
          <div className="max-w-[92%] rounded-xl px-4 py-3 text-[14px]" style={{ background: "#FBF8F1", border: "2px solid var(--pr-ink)" }}>
            {intro}
          </div>
        </div>}

        {/* preamble (legacy desk notes before the first question) */}
        {pre.map((m, i) => renderReport(m, `pre-${i}`))}

        {/* sittings */}
        {sittings.map((s, n) => (
          <div key={n} id={`sit-${ticker}-${n}`}>
            <button
              onClick={() => setSitOpen((p) => ({ ...p, [n]: !isOpen(n) }))}
              className="w-full flex items-baseline gap-2.5 text-left py-1 px-0.5 hover:opacity-75"
            >
              <span className="pp-mono text-[9.5px] tracking-[0.14em] shrink-0" style={{ color: n === sittings.length - 1 ? "var(--pr-orange)" : "var(--pr-faint)" }}>
                QUESTION {String(n + 1).padStart(2, "0")} {isOpen(n) ? "▾" : "▸"}
              </span>
              {!isOpen(n) && (
                <span className="text-[13px] font-semibold truncate">{displayContent(s.question.content)}</span>
              )}
              {!isOpen(n) && s.answers[s.answers.length - 1]?.transcript && (
                <span className="pp-mono text-[9px] shrink-0 ml-auto" style={{ color: "var(--pr-faint)" }}>
                  grounded
                </span>
              )}
            </button>
            {isOpen(n) && (
              <div className="space-y-3">
                {renderUser(s.question, `q-${n}`)}
                {s.answers.map((m, j) => renderReport(m, `${n}-${j}`, displayContent(s.question.content)))}
              </div>
            )}
          </div>
        ))}

        {/* live sitting — the Desk narrating its work */}
        {streaming && (
          <div className="space-y-3">
            {lines.length > 0 && (
              <div className="rounded-xl px-4 py-3 space-y-1.5" style={{ border: "2px dashed rgba(22,21,15,.35)" }}>
                {lines.map((l, i) => (
                  <p key={i} className="pp-mono text-[11px] leading-relaxed m-0" style={{ color: i === lines.length - 1 && !answer ? "var(--pr-ink)" : "var(--pr-dim)" }}>
                    {l}
                    {i === lines.length - 1 && !answer && !notes && <span className="animate-pulse"> ▊</span>}
                  </p>
                ))}
              </div>
            )}

            {notes && !notesDone && (
              <div className="rounded-xl px-4 py-3" style={{ border: "2px dashed rgba(22,21,15,.3)", background: "#FBF8F1" }}>
                <span className="pp-mono text-[9px] uppercase tracking-[0.16em] block mb-1.5" style={{ color: "var(--pr-faint)" }}>
                  Working draft — will be audited before the answer
                </span>
                <div ref={notesRef} className="text-[13px] leading-relaxed overflow-y-auto" style={{ maxHeight: 180, opacity: 0.65, whiteSpace: "pre-wrap" }}>
                  {notes}
                  <span className="animate-pulse">▊</span>
                </div>
              </div>
            )}
            {notes && notesDone && !answer && (
              <p className="pp-mono text-[10px]" style={{ color: "var(--pr-faint)" }}>
                ▸ working draft closed — under audit
              </p>
            )}

            {answer && (
              <div className="rounded-xl px-4 py-3" style={{ background: "var(--pr-card)", border: "2px solid var(--pr-ink)" }}>
                <span className="pp-mono text-[9.5px] uppercase tracking-[0.18em] block mb-1" style={{ color: "var(--pr-faint)" }}>
                  AMM Desk · writing the answer <span className="animate-pulse">▊</span>
                </span>
                <Md text={answer} />
              </div>
            )}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* composer */}
      <div className={compact ? "rounded-[14px] p-2.5" : "rounded-2xl p-3"} style={{ background: "var(--pr-card)", border: "2px solid var(--pr-ink)" }}>
        <div className="flex items-center gap-2.5">
          {compact && <AmmFox size={42} className="shrink-0" />}
          {onAttachFile && (
            <>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => onPickFiles(e.target.files)} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming}
                className={compact ? "h-8 w-8 rounded-full shrink-0 inline-flex items-center justify-center" : "h-9 w-9 rounded-full shrink-0 inline-flex items-center justify-center"}
                style={{ border: "2px solid var(--pr-ink)", background: "#FBF8F1" }}
                aria-label="Attach a document"
                title="Add a document to the company file so AMM Desk can use it"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  className={compact ? "h-[15px] w-[15px]" : "h-4 w-4"}
                >
                  <path
                    d="m20.5 11.5-8.62 8.62a6 6 0 0 1-8.49-8.49l9.33-9.33a4 4 0 0 1 5.66 5.66l-9.34 9.33a2 2 0 0 1-2.83-2.83l8.63-8.62"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={`Ask AMM Desk about ${ticker}…`}
            disabled={streaming}
            className="flex-1 bg-transparent outline-none text-[14.5px]"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="h-8 px-3 rounded-full pp-mono text-[10px] uppercase tracking-[0.12em] shrink-0"
              style={{ border: "2px solid var(--pr-ink)", color: "var(--pr-ink)" }}
            >
              ■ stop
            </button>
          ) : (
            <button
              onClick={send}
              className={compact
                ? "h-9 px-4 rounded-[7px] pp-mono text-[9px] font-semibold tracking-[0.1em] shrink-0"
                : "h-8 w-8 rounded-full font-bold shrink-0"}
              style={{ background: compact ? "var(--pr-ink)" : "var(--pr-orange)", color: "var(--pr-paper)" }}
              aria-label="Send"
            >
              {compact ? "ASK →" : "↑"}
            </button>
          )}
        </div>
        {!compact && <div className="flex items-center gap-1.5 mt-2.5">
          <span className="pp-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--pr-faint)" }}>
            1 research credit per question · answers stay inside your AMM file
          </span>
          <span className="ml-auto inline-flex items-center gap-3">
            <UsageMeter variant="compact" />
            <span className="pp-mono text-[9px]" style={{ color: "var(--pr-faint)" }}>
              {attachNote || fileStatus}
            </span>
          </span>
        </div>}
        {compact && attachNote && (
          <p className="pp-mono text-[8px] mt-1.5 text-right" style={{ color: "var(--pr-faint)" }}>{attachNote}</p>
        )}
      </div>
      {!compact && <p className="pp-mono text-[10px] mt-2" style={{ color: "var(--pr-faint)" }}>
        AMM Desk provides research, not advice · answers use your verified company file and selected sources · never buy/sell calls
      </p>}
    </div>
  );
}
