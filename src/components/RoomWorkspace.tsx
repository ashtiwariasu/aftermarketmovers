"use client";

import { useCallback, useEffect, useState } from "react";
import CouncilRoom, { type RoomMsg } from "@/components/CouncilRoom";
import CompanyFilePanel, { type PanelDoc } from "@/components/CompanyFilePanel";

interface Props {
  ticker: string;
  userEmail: string;
  wsUrl: string;
  initialSessionId: string | null;
  history: RoomMsg[];
  intro: string;
  contextNote: string;
  initialFolderId: string | null;
}

export default function RoomWorkspace({
  ticker,
  userEmail,
  wsUrl,
  initialSessionId,
  history,
  intro,
  contextNote,
  initialFolderId,
}: Props) {
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [docs, setDocs] = useState<PanelDoc[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/desk/file?ticker=${ticker}`);
      if (!res.ok) return;
      const json = await res.json();
      setFolderId(json.folderId ?? null);
      setDocs(Array.isArray(json.docs) ? json.docs : []);
      setExcluded(new Set(Array.isArray(json.excluded) ? json.excluded : []));
    } catch {
      /* panel stays in last known state */
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  function persistExcluded(next: Set<string>) {
    fetch("/api/desk/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-excluded", ticker, excluded: [...next] }),
    }).catch(() => {});
  }

  function onToggle(docId: string, included: boolean) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (included) next.delete(docId);
      else next.add(docId);
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

  async function onFileReport(name: string, content: string): Promise<boolean> {
    return onAddNote(name, content);
  }

  const includedDocs = docs.filter((d) => !excluded.has(d.id));
  const tokens = includedDocs.reduce((s, d) => s + d.estimated_tokens, 0);
  const libraryContext =
    folderId && excluded.size === 0
      ? { folder_ids: [folderId], document_ids: [], chat_ids: [] }
      : {
          folder_ids: [],
          document_ids: includedDocs.map((d) => d.id),
          chat_ids: [],
        };
  const fileStatus =
    docs.length > 0
      ? `■ ${includedDocs.length} of ${docs.length} file sources in context · ~${(tokens / 1000).toFixed(1)}k tokens`
      : folderId
        ? "company file attached"
        : "live deliberation";

  return (
    <div className="grid lg:grid-cols-12 gap-6 items-start">
      <div className="lg:col-span-8">
        <CouncilRoom
          ticker={ticker}
          userEmail={userEmail}
          wsUrl={wsUrl}
          initialSessionId={initialSessionId}
          history={history}
          intro={intro}
          contextNote={contextNote}
          libraryContext={libraryContext}
          fileStatus={fileStatus}
          onFileReport={onFileReport}
        />
      </div>
      <aside className="lg:col-span-4 lg:sticky lg:top-20">
        <CompanyFilePanel
          ticker={ticker}
          loading={loading}
          docs={docs}
          excluded={excluded}
          onToggle={onToggle}
          onAddNote={onAddNote}
          onSaveNote={onSaveNote}
          loadDoc={loadDoc}
        />
      </aside>
    </div>
  );
}
