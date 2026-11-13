"use client";

import { useCallback, useEffect, useState } from "react";
import CouncilRoom, { type RoomMsg } from "@/components/CouncilRoom";
import ContextTabs, { type FreshWire, type FreshFiling } from "@/components/ContextTabs";
import { NEWS_BUCKET_FILE_PREFIX } from "@/lib/newsBuckets";
import type { PanelDoc } from "@/components/CompanyFilePanel";

export interface RoomSessionMeta {
  id: string;
  title: string;
  at: number;
}

interface Props {
  ticker: string;
  userEmail: string;
  wsUrl: string;
  intro: string;
  contextNote: string;
  initialFolderId: string | null;
  initialDocs: PanelDoc[];
  initialExcluded: string[];
  sessions: RoomSessionMeta[];
  latestSessionId: string | null;
  initialHistory: RoomMsg[]; // transcript of the latest session
  freshNews: FreshWire[];
  freshFilings: FreshFiling[];
}

const NEW_KEY = "__new__";

export default function Workbench({
  ticker,
  userEmail,
  wsUrl,
  intro,
  contextNote,
  initialFolderId,
  initialDocs,
  initialExcluded,
  sessions,
  latestSessionId,
  initialHistory,
  freshNews,
  freshFilings,
}: Props) {
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [docs, setDocs] = useState<PanelDoc[]>(initialDocs);
  const [excluded, setExcluded] = useState<Set<string>>(new Set(initialExcluded));
  const [loading, setLoading] = useState(false);
  const [filedFresh, setFiledFresh] = useState<Set<string>>(new Set());
  const [sessionList, setSessionList] = useState<RoomSessionMeta[]>(sessions);
  const [active, setActive] = useState<string>(latestSessionId ?? NEW_KEY);
  const [histories, setHistories] = useState<Record<string, RoomMsg[]>>(
    latestSessionId ? { [latestSessionId]: initialHistory } : {}
  );
  const [loadingSession, setLoadingSession] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/desk/file?ticker=${ticker}`);
      if (!res.ok) return;
      const json = await res.json();
      setFolderId(json.folderId ?? null);
      setDocs(Array.isArray(json.docs) ? json.docs : []);
      setExcluded(new Set(Array.isArray(json.excluded) ? json.excluded : []));
    } catch {
      /* keep last known state */
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    if (initialDocs.length !== 0) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh, initialDocs.length]);

  function persistExcluded(next: Set<string>) {
    fetch("/api/desk/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-excluded", ticker, excluded: [...next] }),
    }).catch(() => {});
  }

  function onToggle(sourceKey: string, included: boolean) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (included) next.delete(sourceKey);
      else next.add(sourceKey);
      persistExcluded(next);
      return next;
    });
  }

  async function onAddNote(name: string, content: string): Promise<boolean> {
    const res = await fetch("/api/desk/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add-note", ticker, name, content }),
    }).catch(() => null);
    const ok = Boolean(res?.ok);
    if (ok) await refresh();
    return ok;
  }

  async function onSaveNote(docId: string, content: string): Promise<boolean> {
    const res = await fetch("/api/desk/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update-note", ticker, docId, content }),
    }).catch(() => null);
    return Boolean(res?.ok);
  }

  async function loadDoc(docId: string) {
    const res = await fetch(`/api/desk/file?ticker=${ticker}&doc=${docId}`).catch(() => null);
    if (!res?.ok) return null;
    return res.json();
  }

  async function onFileFresh(wire: FreshWire) {
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const ok = await onAddNote(
      `${NEWS_BUCKET_FILE_PREFIX[wire.bucket]} — ${wire.title.slice(0, 90)} · ${date}`,
      `# ${wire.title}\n\n` +
      `- Authority: ${wire.authority ?? "NEWS"}${wire.traceable === false ? " · discovery only" : ""}\n` +
      `- Published: ${wire.publishedDate ?? wire.stamp}\n` +
      `- Publisher: ${wire.publisher}\n` +
      `- Original source: [open document](${wire.link})\n` +
      `- Provenance observations: ${wire.sourceCount ?? 1}\n\n` +
      `_Filed from the traceable news ledger — evidence, not endorsement._`
    );
    if (ok) setFiledFresh((prev) => new Set(prev).add(wire.link));
  }

  async function onFileFiling(filing: FreshFiling) {
    const res = await fetch("/api/desk/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "file-filing",
        ticker,
        url: filing.url,
        formLabel: filing.formLabel,
        date: filing.date,
        title: filing.title,
      }),
    }).catch(() => null);
    if (res?.ok) {
      setFiledFresh((prev) => new Set(prev).add(filing.url));
      await refresh();
    }
  }

  async function onAttachFile(file: File): Promise<{ ok: boolean; name?: string }> {
    const fd = new FormData();
    fd.append("ticker", ticker);
    fd.append("file", file, file.name);
    const res = await fetch("/api/desk/file", { method: "POST", body: fd }).catch(() => null);
    if (!res?.ok) return { ok: false };
    await refresh();
    return { ok: true, name: file.name };
  }

  function onSessionEvent(sessionId: string, title?: string) {
    setSessionList((prev) => {
      const existing = prev.find((s) => s.id === sessionId);
      if (existing) {
        return prev.map((s) =>
          s.id === sessionId && title ? { ...s, title } : s
        );
      }
      return [{ id: sessionId, title: title ?? "New session", at: Date.now() }, ...prev];
    });
    if (active === NEW_KEY) setActive(sessionId);
    fetch("/api/desk/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, sessionId, ...(title ? { title } : {}) }),
    }).catch(() => {});
  }

  async function switchSession(sid: string) {
    if (sid === active) return;
    setActive(sid);
    if (sid !== NEW_KEY && !histories[sid]) {
      setLoadingSession(true);
      try {
        const res = await fetch(`/api/desk/room?ticker=${ticker}&session=${sid}`);
        if (res.ok) {
          const json = await res.json();
          setHistories((prev) => ({ ...prev, [sid]: json.messages ?? [] }));
        } else {
          setHistories((prev) => ({ ...prev, [sid]: [] }));
        }
      } catch {
        setHistories((prev) => ({ ...prev, [sid]: [] }));
      } finally {
        setLoadingSession(false);
      }
    }
  }

  const includedDocs = docs.filter((d) => !excluded.has(d.id));
  const freshSourceKeys = [
    ...freshNews.filter((wire) => !filedFresh.has(wire.link)).map((wire) => wire.link),
    ...freshFilings.filter((filing) => !filedFresh.has(filing.url)).map((filing) => filing.url),
  ];
  const allSourceKeys = [...new Set([...docs.map((doc) => doc.id), ...freshSourceKeys])];
  const selectedSourceCount = allSourceKeys.filter((key) => !excluded.has(key)).length;
  const selectionPercent = allSourceKeys.length === 0
    ? 0
    : Math.round((selectedSourceCount / allSourceKeys.length) * 100);
  const libraryContext =
    folderId && excluded.size === 0
      ? { folder_ids: [folderId], document_ids: [], chat_ids: [] }
      : { folder_ids: [], document_ids: includedDocs.map((d) => d.id), chat_ids: [] };

  const isNew = active === NEW_KEY;
  const activeMeta = sessionList.find((s) => s.id === active);

  return (
    <div className="space-y-3">
      <section
        className="rounded-[12px] overflow-hidden"
        style={{ border: "1.5px solid rgba(22,21,15,.35)", background: "var(--pr-card)" }}
      >
        <button
          type="button"
          onClick={() => setContextOpen((open) => !open)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left"
          aria-expanded={contextOpen}
        >
          <span className="pp-mono text-[9px] uppercase tracking-[0.18em]">CONTEXT &amp; SOURCES</span>
          <span className="pp-mono text-[8.5px]" style={{ color: "var(--pr-faint)" }}>
            {selectedSourceCount}/{allSourceKeys.length} SELECTED · INTENT-MATCHED
          </span>
          <span className="ml-auto pp-mono text-[12px]" aria-hidden>{contextOpen ? "−" : "+"}</span>
        </button>
        {contextOpen && (
          <div style={{ borderTop: "1.5px solid var(--pr-ink)" }}>
            <div className="flex items-center gap-3 flex-wrap px-4 py-2" style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}>
              <span className="pp-mono text-[8.5px]" style={{ color: "var(--pr-lime)" }}>
                ALL CHECKED SOURCES STAY AVAILABLE · EACH QUESTION RETRIEVES THE RELEVANT EVIDENCE
              </span>
              <div className="flex-1 max-w-[220px] h-[6px] rounded-full overflow-hidden" style={{ border: "1px solid rgba(244,241,234,.5)", background: "rgba(244,241,234,.12)" }}>
                <div
                  className="h-full transition-all"
                  style={{ width: `${selectionPercent}%`, background: "var(--pr-lime)" }}
                />
              </div>
            </div>
            <ContextTabs
              ticker={ticker}
              loading={loading}
              docs={docs}
              excluded={excluded}
              freshNews={freshNews}
              freshFilings={freshFilings}
              filedFresh={filedFresh}
              onToggle={onToggle}
              onFileFresh={onFileFresh}
              onFileFiling={onFileFiling}
              onAddNote={onAddNote}
              onSaveNote={onSaveNote}
              loadDoc={loadDoc}
            />
          </div>
        )}
      </section>

      <section
        className="rounded-[14px] overflow-hidden"
        style={{ border: "2px solid var(--pr-ink)", boxShadow: "5px 5px 0 var(--pr-ink)", background: "var(--pr-card)" }}
      >
        <header className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1.5px solid rgba(22,21,15,.22)" }}>
          <span className="pp-mono text-[9px] uppercase tracking-[0.18em]">ASK AMM DESK</span>
          <span className="truncate pp-mono text-[8.5px]" style={{ color: "var(--pr-faint)" }}>
            {isNew || !activeMeta ? "NEW SESSION" : activeMeta.title.toUpperCase()}
          </span>
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="ml-auto pp-mono text-[8px] uppercase tracking-[0.1em] hover:opacity-65"
            aria-expanded={historyOpen}
          >
            HISTORY · {sessionList.length}
          </button>
          <button
            type="button"
            onClick={() => setActive(NEW_KEY)}
            className="pp-mono text-[8px] uppercase tracking-[0.08em] px-2.5 py-1 rounded-full"
            style={{ border: "1.5px solid var(--pr-ink)", background: "var(--pr-lime)" }}
          >
            + NEW
          </button>
        </header>

        {historyOpen && (
          <div className="flex gap-2 overflow-x-auto px-4 py-2.5" style={{ borderBottom: "1.5px solid rgba(22,21,15,.18)", background: "#FFFDF6" }}>
            {sessionList.length === 0 && (
              <span className="pp-mono text-[8.5px]" style={{ color: "var(--pr-faint)" }}>NO EARLIER SESSIONS</span>
            )}
            {sessionList.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => void switchSession(session.id)}
                className="shrink-0 rounded-full px-3 py-1.5 text-left"
                style={{
                  border: "1.5px solid var(--pr-ink)",
                  background: session.id === active ? "var(--pr-ink)" : "var(--pr-card)",
                  color: session.id === active ? "var(--pr-paper)" : "var(--pr-ink)",
                }}
              >
                <span className="block max-w-[180px] truncate text-[10.5px] font-semibold">{session.title}</span>
                <span className="block pp-mono text-[7.5px] opacity-60">
                  {new Date(session.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="px-4 py-4 min-w-0">
          {loadingSession ? (
            <p className="pp-mono text-[10px] py-8 animate-pulse" style={{ color: "var(--pr-faint)" }}>
              OPENING THE SESSION…
            </p>
          ) : (
            <CouncilRoom
              compact
              key={isNew ? `new-${sessionList.length}` : active}
              ticker={ticker}
              userEmail={userEmail}
              wsUrl={wsUrl}
              initialSessionId={isNew ? null : active}
              history={isNew ? [] : (histories[active] ?? [])}
              intro={
                isNew || !activeMeta
                  ? intro
                  : `Session: ${activeMeta.title}. AMM Desk continues with the company file as context.`
              }
              contextNote={contextNote}
              libraryContext={libraryContext}
              fileStatus={`${selectedSourceCount}/${allSourceKeys.length} SOURCES SELECTED · INTENT-MATCHED`}
              onFileReport={onAddNote}
              onSessionEvent={onSessionEvent}
              onAttachFile={onAttachFile}
            />
          )}
        </div>
      </section>
    </div>
  );
}
