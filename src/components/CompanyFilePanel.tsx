"use client";

import { useState } from "react";
import Md from "@/components/Md";

export interface PanelDoc {
  id: string;
  name: string;
  mime_type: string;
  estimated_tokens: number;
}

export type DocKind = "evidence" | "report" | "filing" | "note";

export function docKind(doc: PanelDoc, ticker: string): DocKind {
  if (doc.name.startsWith(`${ticker} evidence`)) return "evidence";
  if (doc.name.startsWith("Report — ")) return "report";
  if (/^(10-K|10-Q|8-K|DEF 14A|S-1|13F)/i.test(doc.name)) return "filing";
  return "note";
}

const KIND_TAG: Record<DocKind, { label: string; bg: string; fg: string }> = {
  evidence: { label: "AUTO", bg: "var(--pr-lime)", fg: "var(--pr-ink)" },
  report: { label: "REPORT", bg: "var(--pr-ink)", fg: "var(--pr-paper)" },
  filing: { label: "FILING", bg: "var(--pr-card)", fg: "var(--pr-ink)" },
  note: { label: "NOTE", bg: "var(--pr-card)", fg: "var(--pr-ink)" },
};

const SECTIONS: Array<{ kind: DocKind; title: string }> = [
  { kind: "evidence", title: "Evidence · added each day by AMM Desk" },
  { kind: "report", title: "AMM Desk answers · saved from your questions" },
  { kind: "filing", title: "SEC filings" },
  { kind: "note", title: "Your notes & uploads" },
];

function fmtTokens(t: number): string {
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k tk`;
  return `${t} tk`;
}

interface Props {
  ticker: string;
  loading: boolean;
  docs: PanelDoc[];
  excluded: Set<string>;
  onToggle: (docId: string, included: boolean) => void;
  onAddNote: (name: string, content: string) => Promise<boolean>;
  onSaveNote: (docId: string, content: string) => Promise<boolean>;
  loadDoc: (docId: string) => Promise<{ content?: string; url?: string } | null>;
}

export default function CompanyFilePanel({
  ticker,
  loading,
  docs,
  excluded,
  onToggle,
  onAddNote,
  onSaveNote,
  loadDoc,
}: Props) {
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const included = docs.filter((d) => !excluded.has(d.id));
  const tokens = included.reduce((s, d) => s + d.estimated_tokens, 0);
  const budget = 12_000;

  async function view(doc: PanelDoc) {
    if (openDoc === doc.id) {
      setOpenDoc(null);
      setEditing(false);
      return;
    }
    setOpenDoc(doc.id);
    setEditing(false);
    setOpenContent("…");
    const res = await loadDoc(doc.id);
    if (res?.url) {
      window.open(res.url, "_blank", "noopener");
      setOpenDoc(null);
      return;
    }
    setOpenContent(res?.content ?? "(no content)");
  }

  async function saveOpen() {
    if (!openDoc) return;
    setBusy(true);
    const ok = await onSaveNote(openDoc, openContent);
    setBusy(false);
    if (ok) setEditing(false);
  }

  async function addNote() {
    if (!newName.trim() || !newContent.trim()) return;
    setBusy(true);
    const ok = await onAddNote(newName.trim(), newContent);
    setBusy(false);
    if (ok) {
      setAdding(false);
      setNewName("");
      setNewContent("");
    }
  }

  return (
    <div className="rounded-[14px] overflow-hidden" style={{ border: "2px solid var(--pr-ink)" }}>
      <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}>
        <span className="pp-mono text-[10px] uppercase tracking-[0.2em]">
          {ticker} · Company file
        </span>
        <span className="pp-mono text-[9px]" style={{ color: "var(--pr-lime)" }}>
          LIVE CONTEXT
        </span>
      </div>

      {/* meter */}
      <div className="px-4 py-2.5" style={{ background: "#FBF8F1", borderBottom: "1.5px solid rgba(22,21,15,.15)" }}>
        <div className="flex justify-between pp-mono text-[9px]" style={{ color: "var(--pr-dim)" }}>
          <span>
            {included.length} SOURCE{included.length === 1 ? "" : "S"} SELECTED
          </span>
          <span style={{ color: "var(--pr-faint)" }}>READY FOR QUESTIONS</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden mt-1.5" style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-card)" }}>
          <div
            className="h-full transition-all"
            style={{
              width: `${Math.min(100, Math.round((tokens / budget) * 100))}%`,
              background: tokens > budget ? "var(--pr-orange)" : "var(--pr-lime)",
            }}
          />
        </div>
      </div>

      {/* sections */}
      <div className="max-h-[520px] overflow-y-auto" style={{ background: "var(--pr-card)" }}>
        {loading ? (
          <p className="pp-mono text-[10px] px-4 py-4 animate-pulse" style={{ color: "var(--pr-faint)" }}>
            opening the file…
          </p>
        ) : (
          SECTIONS.map(({ kind, title }) => {
            const rows = docs.filter((d) => docKind(d, ticker) === kind);
            if (rows.length === 0 && kind !== "note") return null;
            return (
              <div key={kind} className="px-4 pt-2.5 pb-1">
                <div className="flex items-center justify-between">
                  <p className="pp-mono text-[8.5px] uppercase tracking-[0.2em]" style={{ color: "var(--pr-faint)" }}>
                    {title}
                  </p>
                  {kind === "note" && (
                    <button
                      onClick={() => setAdding(!adding)}
                      className="pp-mono text-[8.5px] uppercase tracking-[0.1em]"
                      style={{ color: "var(--pr-blue)" }}
                    >
                      + add note
                    </button>
                  )}
                </div>

                {kind === "note" && adding && (
                  <div className="my-2 space-y-1.5">
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Note title — e.g. My thesis"
                      className="w-full rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                      style={{ border: "2px solid var(--pr-ink)", background: "#FFFDF6" }}
                      maxLength={140}
                    />
                    <textarea
                      value={newContent}
                      onChange={(e) => setNewContent(e.target.value)}
                      placeholder="Your thesis, a broker note, anything — AMM Desk reads what's selected."
                      className="w-full rounded-lg px-2.5 py-1.5 pp-mono text-[10.5px] outline-none resize-y"
                      style={{ border: "2px solid var(--pr-ink)", background: "#FFFDF6", minHeight: 90 }}
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={addNote}
                        disabled={busy}
                        className="pp-mono text-[8.5px] uppercase tracking-[0.1em] px-2.5 py-1 rounded-full"
                        style={{ background: "var(--pr-orange)", color: "var(--pr-paper)", border: "1.5px solid var(--pr-ink)" }}
                      >
                        {busy ? "filing…" : "file it"}
                      </button>
                      <button
                        onClick={() => setAdding(false)}
                        className="pp-mono text-[8.5px] uppercase tracking-[0.1em] px-2.5 py-1 rounded-full"
                        style={{ border: "1.5px solid var(--pr-ink)" }}
                      >
                        cancel
                      </button>
                    </div>
                  </div>
                )}

                {rows.map((d) => {
                  const off = excluded.has(d.id);
                  const tag = KIND_TAG[kind];
                  const isNoteLike = d.mime_type.includes("markdown") || d.mime_type.includes("text");
                  return (
                    <div key={d.id}>
                      <div className="flex items-center gap-2 py-1.5" style={{ borderBottom: "1px solid rgba(22,21,15,.08)" }}>
                        <input
                          type="checkbox"
                          checked={!off}
                          onChange={(e) => onToggle(d.id, e.target.checked)}
                          className="w-[15px] h-[15px] shrink-0 cursor-pointer"
                          style={{ accentColor: "var(--pr-ink)" }}
                        />
                        <span
                          className="pp-mono text-[7.5px] px-1.5 rounded-full shrink-0"
                          style={{ border: "1px solid var(--pr-ink)", background: tag.bg, color: tag.fg }}
                        >
                          {tag.label}
                        </span>
                        <button
                          onClick={() => view(d)}
                          className="text-[12px] font-medium flex-1 min-w-0 truncate text-left hover:opacity-70"
                          style={off ? { color: "var(--pr-faint)", textDecoration: "line-through" } : {}}
                          title={d.name}
                        >
                          {d.name}
                        </button>
                        <span className="pp-mono text-[8.5px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                          {fmtTokens(d.estimated_tokens)}
                        </span>
                        <button
                          onClick={() => view(d)}
                          className="pp-mono text-[8.5px] shrink-0"
                          style={{ color: "var(--pr-blue)" }}
                        >
                          {openDoc === d.id ? "close" : "view"}
                        </button>
                      </div>
                      {openDoc === d.id && (
                        <div className="my-2 rounded-lg overflow-hidden" style={{ border: "2px solid var(--pr-ink)", background: "#FFFDF6" }}>
                          {editing ? (
                            <>
                              <textarea
                                value={openContent}
                                onChange={(e) => setOpenContent(e.target.value)}
                                className="w-full px-2.5 py-2 pp-mono text-[10.5px] outline-none resize-y"
                                style={{ minHeight: 140, background: "#FFFDF6" }}
                              />
                              <div className="flex gap-1.5 px-2.5 py-1.5" style={{ borderTop: "1.5px solid rgba(22,21,15,.15)" }}>
                                <button onClick={saveOpen} disabled={busy} className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full" style={{ background: "var(--pr-lime)", border: "1.5px solid var(--pr-ink)" }}>
                                  {busy ? "saving…" : "save"}
                                </button>
                                <button onClick={() => setEditing(false)} className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full" style={{ border: "1.5px solid var(--pr-ink)" }}>
                                  cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="px-3 py-2 text-[12px]" style={{ maxHeight: 260, overflowY: "auto" }}>
                                <Md text={openContent} />
                              </div>
                              {isNoteLike && (
                                <div className="px-2.5 py-1.5" style={{ borderTop: "1.5px solid rgba(22,21,15,.15)" }}>
                                  <button onClick={() => setEditing(true)} className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full" style={{ border: "1.5px solid var(--pr-ink)" }}>
                                    edit
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {rows.length === 0 && kind === "note" && !adding && (
                  <p className="pp-mono text-[9px] py-1.5" style={{ color: "var(--pr-faint)" }}>
                    nothing added yet — add your thesis, broker notes, anything
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="px-4 py-2.5 pp-mono text-[8.5px] leading-relaxed" style={{ borderTop: "1.5px solid rgba(22,21,15,.15)", color: "var(--pr-faint)", background: "var(--pr-card)" }}>
        Selected sources stay available. AMM Desk retrieves the relevant
        passages for each question.
      </div>
    </div>
  );
}
