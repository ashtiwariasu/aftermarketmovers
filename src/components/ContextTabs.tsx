"use client";

import { useState } from "react";
import Md from "@/components/Md";
import type { PanelDoc } from "@/components/CompanyFilePanel";
import type { NewsBucket } from "@/lib/newsBuckets";

export interface FreshWire {
  title: string;
  publisher: string;
  link: string;
  stamp: string;
  publishedDate?: string;
  authority?: string;
  bucket: NewsBucket;
  sourceCount?: number;
  traceable?: boolean;
}

export interface FreshFiling {
  formLabel: string;
  date: string;
  url: string;
  title: string;
}

export type TabKey = "ev" | NewsBucket | "num" | "led" | "you";

export function tabForDoc(doc: PanelDoc, ticker: string): TabKey {
  if (doc.name.startsWith(`${ticker} evidence`)) return "ev";
  if (doc.name.startsWith("Story — ")) return "ev";
  if (doc.name.startsWith("Card — ")) return "ev";
  if (doc.name.startsWith("Filing — ")) return "filings";
  if (doc.name.startsWith("Company — ")) return "company";
  if (doc.name.startsWith("News — ") || doc.name.startsWith("Wire — ")) return "news";
  if (doc.name.startsWith("Regulatory — ")) return "regulatory";
  if (doc.name.startsWith("Market — ")) return "market";
  if (doc.name.startsWith("Discovery — ")) return "discovery";
  if (doc.name.startsWith("Social — ")) return "social";
  if (doc.name.startsWith("Claims ledger")) return "led";
  if (doc.name.startsWith("Fundamentals")) return "num";
  if (/^(10-K|10-Q|8-K|DEF 14A|S-1|13F|Form 4|SC 13)/i.test(doc.name)) return "filings";
  return "you";
}

function rowTag(doc: PanelDoc, ticker: string): { label: string; lime?: boolean; ink?: boolean } {
  if (doc.name.startsWith(`${ticker} evidence`)) return { label: "AUTO", lime: true };
  if (doc.name.startsWith("Story — ")) return { label: "STORY", lime: true };
  if (doc.name.startsWith("Card — ")) return { label: "CARD", ink: true };
  if (doc.name.startsWith("Report — ")) return { label: "REPORT", ink: true };
  if (doc.name.startsWith("Filing — ")) return { label: "FILING", ink: true };
  if (doc.name.startsWith("Company — ")) return { label: "COMPANY", lime: true };
  if (doc.name.startsWith("News — ") || doc.name.startsWith("Wire — ")) return { label: "PRESS" };
  if (doc.name.startsWith("Regulatory — ")) return { label: "REGULATOR", ink: true };
  if (doc.name.startsWith("Market — ")) return { label: "TRADING" };
  if (doc.name.startsWith("Discovery — ")) return { label: "DISCOVERY" };
  if (doc.name.startsWith("Social — ")) return { label: "SOCIAL" };
  if (doc.name.startsWith("Claims ledger")) return { label: "CLAIMS", lime: true };
  const filing = doc.name.match(/^(10-K|10-Q|8-K|DEF 14A|S-1|13F|Form 4|SC 13[DG]?)/i);
  if (filing) return { label: filing[1].toUpperCase(), ink: true };
  if (doc.name.startsWith("Fundamentals")) return { label: "NUMBERS", lime: true };
  if (doc.mime_type.includes("pdf")) return { label: "PDF" };
  return { label: "NOTE" };
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "ev", label: "Evidence" },
  { key: "filings", label: "Filings" },
  { key: "company", label: "Company" },
  { key: "num", label: "Numbers" },
  { key: "news", label: "News" },
  { key: "regulatory", label: "Regulatory" },
  { key: "market", label: "Market" },
  { key: "discovery", label: "Discovery" },
  { key: "social", label: "Social" },
  { key: "led", label: "Ledger" },
  { key: "you", label: "Yours" },
];

const EMPTY: Record<TabKey, string> = {
  ev: "No evidence added yet — AMM Desk adds an update each day.",
  filings: "No filings on the official record yet.",
  company: "No verified company announcements in this window.",
  num: "The fundamentals note lands here from the company's SEC XBRL filings.",
  news: "No licensed or verified publisher news in this window.",
  regulatory: "No verified regulator or exchange notices in this window.",
  market: "No market snapshot available.",
  discovery: "No open-web discovery items in this window.",
  social: "Social signals are isolated until a licensed, identity-scored source is configured.",
  led: "No claims locked on this file yet.",
  you: "Nothing filed yet — add your thesis, broker notes, anything.",
};

function fmtTokens(t: number): string {
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k tk` : `${t} tk`;
}

function dateFromName(name: string): string {
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    return `${months[parseInt(iso[2], 10) - 1]} ${parseInt(iso[3], 10)}`;
  }
  const md = name.match(/·\s*((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})/);
  return md ? md[1].toUpperCase().slice(0, 6) : "";
}

interface Props {
  ticker: string;
  loading: boolean;
  docs: PanelDoc[];
  excluded: Set<string>;
  freshNews: FreshWire[];
  freshFilings: FreshFiling[];
  filedFresh: Set<string>; // links/urls already filed this session
  onToggle: (sourceKey: string, included: boolean) => void;
  onFileFresh: (wire: FreshWire) => Promise<void>;
  onFileFiling: (filing: FreshFiling) => Promise<void>;
  onAddNote: (name: string, content: string) => Promise<boolean>;
  onSaveNote: (docId: string, content: string) => Promise<boolean>;
  loadDoc: (docId: string) => Promise<{ content?: string; url?: string } | null>;
}

export default function ContextTabs({
  ticker,
  loading,
  docs,
  excluded,
  freshNews,
  freshFilings,
  filedFresh,
  onToggle,
  onFileFresh,
  onFileFiling,
  onAddNote,
  onSaveNote,
  loadDoc,
}: Props) {
  const [tab, setTab] = useState<TabKey>("ev");
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const grouped = new Map<TabKey, PanelDoc[]>();
  for (const t of TABS) grouped.set(t.key, []);
  for (const d of docs) grouped.get(tabForDoc(d, ticker))!.push(d);

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

  const rows = grouped.get(tab) ?? [];
  const freshForTab = freshNews.filter((wire) => wire.bucket === tab && !filedFresh.has(wire.link));
  const showFresh = freshForTab.length > 0;
  const showFilings = tab === "filings";

  return (
    <div style={{ borderBottom: "2px solid var(--pr-ink)", background: "#FFFDF6" }}>
      {/* tab bar with n/m badges */}
      <div className="flex gap-1.5 flex-wrap px-3 pt-2.5">
        {TABS.map((t) => {
          const items = grouped.get(t.key) ?? [];
          const fresh = freshNews.filter((wire) => wire.bucket === t.key && !filedFresh.has(wire.link));
          const freshFilingItems = t.key === "filings"
            ? freshFilings.filter((filing) => !filedFresh.has(filing.url))
            : [];
          const total = items.length + fresh.length + freshFilingItems.length;
          const on = items.filter((d) => !excluded.has(d.id)).length
            + fresh.filter((wire) => !excluded.has(wire.link)).length
            + freshFilingItems.filter((filing) => !excluded.has(filing.url)).length;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="pp-mono text-[8.5px] uppercase tracking-[0.1em] px-2.5 pt-1.5 pb-1 rounded-t-lg"
              style={{
                border: "2px solid var(--pr-ink)",
                borderBottom: "none",
                background: active ? "var(--pr-ink)" : "var(--pr-card)",
                color: active ? "var(--pr-paper)" : "var(--pr-dim)",
              }}
            >
              {t.label}
              <span className="ml-1" style={{ color: active ? "var(--pr-lime)" : "var(--pr-faint)" }}>
                {on}/{total}
              </span>
            </button>
          );
        })}
      </div>

      {/* active pane */}
      <div className="max-h-[230px] overflow-y-auto px-3 pb-2" style={{ borderTop: "2px solid var(--pr-ink)" }}>
        {loading ? (
          <p className="pp-mono text-[9.5px] py-3 animate-pulse" style={{ color: "var(--pr-faint)" }}>
            opening the file…
          </p>
        ) : (
          <>
            {tab === "you" && (
              <div className="flex justify-end pt-1.5">
                <button
                  onClick={() => setAdding(!adding)}
                  className="pp-mono text-[8.5px] uppercase tracking-[0.1em]"
                  style={{ color: "var(--pr-blue)" }}
                >
                  + add note
                </button>
              </div>
            )}
            {tab === "you" && adding && (
              <div className="my-2 space-y-1.5">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Note title — e.g. My thesis"
                  className="w-full rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                  style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}
                  maxLength={140}
                />
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Your thesis, a broker note, anything — AMM Desk reads what's selected."
                  className="w-full rounded-lg px-2.5 py-1.5 pp-mono text-[10.5px] outline-none resize-y"
                  style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)", minHeight: 80 }}
                />
                <div className="flex gap-1.5 pb-1">
                  <button
                    onClick={async () => {
                      if (!newName.trim() || !newContent.trim()) return;
                      setBusy(true);
                      const ok = await onAddNote(newName.trim(), newContent);
                      setBusy(false);
                      if (ok) {
                        setAdding(false);
                        setNewName("");
                        setNewContent("");
                      }
                    }}
                    disabled={busy}
                    className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full"
                    style={{ background: "var(--pr-orange)", color: "var(--pr-paper)", border: "1.5px solid var(--pr-ink)" }}
                  >
                    {busy ? "filing…" : "file it"}
                  </button>
                  <button
                    onClick={() => setAdding(false)}
                    className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full"
                    style={{ border: "1.5px solid var(--pr-ink)" }}
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}

            {/* Fresh filings are eligible context by default. Filing is a separate persistence action. */}
            {showFilings &&
              freshFilings
                .filter((f) => !filedFresh.has(f.url))
                .map((f) => {
                  const off = excluded.has(f.url);
                  return (
                    <div
                      key={f.url}
                      className="flex items-center gap-2 py-1.5"
                      style={{
                        borderBottom: "1px solid rgba(22,21,15,.08)",
                        background: off ? "var(--pr-card)" : "rgba(217,244,91,.18)",
                        opacity: off ? 0.55 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={(event) => onToggle(f.url, event.target.checked)}
                        aria-label={`Use ${f.title} as context`}
                        className="w-[15px] h-[15px] shrink-0 cursor-pointer ml-1"
                        style={{ accentColor: "var(--pr-ink)" }}
                      />
                    <span className="pp-mono text-[8.5px] w-[44px] shrink-0" style={{ color: "var(--pr-orange)" }}>
                      {f.date.slice(5).replace("-", "/")}
                    </span>
                    <span
                      className="pp-mono text-[7.5px] px-1.5 rounded-full shrink-0"
                      style={{ border: "1px solid var(--pr-ink)", background: "var(--pr-ink)", color: "var(--pr-paper)" }}
                    >
                      {f.formLabel.toUpperCase()}
                    </span>
                    <span className="text-[12px] font-medium flex-1 min-w-0 truncate" title={f.title}>
                      {f.title}
                    </span>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pp-mono text-[8.5px] shrink-0 underline"
                      style={{ color: "var(--pr-blue)" }}
                    >
                      sec.gov
                    </a>
                    <button
                      type="button"
                      onClick={() => void onFileFiling(f)}
                      disabled={busy}
                      className="pp-mono text-[7.5px] uppercase px-2 py-0.5 rounded-full shrink-0"
                      style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-lime)" }}
                    >
                      file it
                    </button>
                  </div>
                  );
                })}

            {/* Fresh wires are eligible context by default. Filing is a separate persistence action. */}
            {showFresh &&
              freshForTab
                .map((w) => {
                  const off = excluded.has(w.link);
                  return (
                    <div
                      key={w.link}
                      className="flex items-center gap-2 py-1.5"
                      style={{
                        borderBottom: "1px solid rgba(22,21,15,.08)",
                        background: off ? "var(--pr-card)" : "rgba(217,244,91,.18)",
                        opacity: off ? 0.55 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={(event) => onToggle(w.link, event.target.checked)}
                        aria-label={`Use ${w.title} as context`}
                        className="w-[15px] h-[15px] shrink-0 cursor-pointer ml-1"
                        style={{ accentColor: "var(--pr-ink)" }}
                      />
                    <span className="pp-mono text-[8px] w-[62px] shrink-0" style={{ color: "var(--pr-orange)" }}>
                      {w.publishedDate ?? "TODAY"}
                    </span>
                    <span
                      className="pp-mono text-[7px] uppercase px-1.5 py-0.5 rounded-full shrink-0"
                      style={{
                        border: "1px solid var(--pr-ink)",
                        background: w.authority === "PRIMARY" ? "var(--pr-lime)" : "var(--pr-card)",
                      }}
                    >
                      {w.authority ?? "NEWS"}
                    </span>
                    <span className="text-[12px] font-medium flex-1 min-w-0 truncate" title={w.title}>
                      {w.title}
                    </span>
                    <a
                      href={w.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pp-mono text-[8px] shrink-0 underline"
                      style={{ color: "var(--pr-blue)" }}
                    >
                      source ↗
                    </a>
                    <button
                      type="button"
                      onClick={() => void onFileFresh(w)}
                      disabled={busy}
                      className="pp-mono text-[7.5px] uppercase px-2 py-0.5 rounded-full shrink-0"
                      style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-lime)" }}
                    >
                      file it
                    </button>
                  </div>
                  );
                })}

            {rows.map((d) => {
              const off = excluded.has(d.id);
              const tag = rowTag(d, ticker);
              const isNoteLike = d.mime_type.includes("markdown") || d.mime_type.includes("text");
              return (
                <div key={d.id}>
                  <div className="flex items-center gap-2 py-1.5" style={{ borderBottom: "1px solid rgba(22,21,15,.08)" }}>
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={(e) => onToggle(d.id, e.target.checked)}
                      className="w-[15px] h-[15px] shrink-0 cursor-pointer ml-1"
                      style={{ accentColor: "var(--pr-ink)" }}
                    />
                    <span className="pp-mono text-[8.5px] w-[44px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                      {dateFromName(d.name)}
                    </span>
                    <span
                      className="pp-mono text-[7.5px] px-1.5 rounded-full shrink-0"
                      style={{
                        border: "1px solid var(--pr-ink)",
                        background: tag.lime ? "var(--pr-lime)" : tag.ink ? "var(--pr-ink)" : "var(--pr-card)",
                        color: tag.ink ? "var(--pr-paper)" : "var(--pr-ink)",
                      }}
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
                    <span className="pp-mono text-[8px] shrink-0" style={{ color: "var(--pr-faint)" }}>
                      {fmtTokens(d.estimated_tokens)}
                    </span>
                    <button onClick={() => view(d)} className="pp-mono text-[8.5px] shrink-0" style={{ color: "var(--pr-blue)" }}>
                      {openDoc === d.id ? "close" : "view"}
                    </button>
                  </div>
                  {openDoc === d.id && (
                    <div className="my-2 rounded-lg overflow-hidden" style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}>
                      {editing ? (
                        <>
                          <textarea
                            value={openContent}
                            onChange={(e) => setOpenContent(e.target.value)}
                            className="w-full px-2.5 py-2 pp-mono text-[10.5px] outline-none resize-y"
                            style={{ minHeight: 120, background: "var(--pr-card)" }}
                          />
                          <div className="flex gap-1.5 px-2.5 py-1.5" style={{ borderTop: "1.5px solid rgba(22,21,15,.15)" }}>
                            <button
                              onClick={async () => {
                                setBusy(true);
                                const ok = await onSaveNote(d.id, openContent);
                                setBusy(false);
                                if (ok) setEditing(false);
                              }}
                              disabled={busy}
                              className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full"
                              style={{ background: "var(--pr-lime)", border: "1.5px solid var(--pr-ink)" }}
                            >
                              {busy ? "saving…" : "save"}
                            </button>
                            <button onClick={() => setEditing(false)} className="pp-mono text-[8.5px] uppercase px-2.5 py-1 rounded-full" style={{ border: "1.5px solid var(--pr-ink)" }}>
                              cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="px-3 py-2 text-[12px]" style={{ maxHeight: 200, overflowY: "auto" }}>
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

            {rows.length === 0 &&
              !showFresh &&
              !(showFilings && freshFilings.some((f) => !filedFresh.has(f.url))) &&
              !adding && (
              <p className="pp-mono text-[9px] py-3" style={{ color: "var(--pr-faint)" }}>
                {EMPTY[tab]}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
