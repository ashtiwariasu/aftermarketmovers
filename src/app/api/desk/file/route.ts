import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDesk, isDeskServiceActive, setCompanyFolder, setContextExclude } from "@/lib/desk";
import {
  ensureCompanyFolder,
  listFolderDocs,
  addEvidenceNote,
  updateNote,
  previewDoc,
  uploadFileToFolder,
} from "@/lib/companyFile";
import { fetchFilingText } from "@/lib/sec";

export const maxDuration = 60;

function sym(v: string | null): string | null {
  const s = (v ?? "").toUpperCase().trim();
  return /^[A-Z.\-]{1,6}$/.test(s) ? s : null;
}

/** The company file, for the room's file panel. */
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk" }, { status: 404 });
  if (!isDeskServiceActive(desk)) return NextResponse.json({ error: "AMM subscription required" }, { status: 402 });

  const ticker = sym(req.nextUrl.searchParams.get("ticker"));
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  // Doc viewer: ?ticker=NVDA&doc=<id>
  const docId = req.nextUrl.searchParams.get("doc");
  if (docId) {
    const doc = await previewDoc(desk.email, docId);
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(doc);
  }

  let folderId = desk.folders?.[ticker] ?? null;
  if (!folderId && desk.tickers.includes(ticker)) {
    folderId = await ensureCompanyFolder(desk.email, ticker);
    if (folderId) await setCompanyFolder(userId, ticker, folderId);
  }
  if (!folderId) return NextResponse.json({ folderId: null, docs: [], excluded: [] });

  const docs = await listFolderDocs(desk.email, folderId);
  return NextResponse.json({
    folderId,
    docs,
    excluded: desk.contextExclude?.[ticker] ?? [],
  });
}

/** Mutations: add-note, update-note, set-excluded, upload (multipart). */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk" }, { status: 404 });
  if (!isDeskServiceActive(desk)) return NextResponse.json({ error: "AMM subscription required" }, { status: 402 });

  // One-machine attach: multipart upload straight into the company folder.
  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const fd = await req.formData();
    const ticker = sym(String(fd.get("ticker") ?? ""));
    const file = fd.get("file");
    if (!ticker || !(file instanceof File)) {
      return NextResponse.json({ error: "ticker and file required" }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "file too large (8MB max)" }, { status: 413 });
    }
    let folderId = desk.folders?.[ticker] ?? null;
    if (!folderId) {
      folderId = await ensureCompanyFolder(desk.email, ticker);
      if (folderId) await setCompanyFolder(userId, ticker, folderId);
    }
    if (!folderId) return NextResponse.json({ error: "no company file" }, { status: 502 });
    const doc = await uploadFileToFolder(desk.email, folderId, file);
    if (!doc?.id) return NextResponse.json({ error: "upload failed" }, { status: 502 });
    return NextResponse.json({ ok: true, doc });
  }

  let body: {
    action?: string;
    ticker?: string;
    name?: string;
    content?: string;
    docId?: string;
    excluded?: string[];
    url?: string;
    formLabel?: string;
    date?: string;
    title?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const ticker = sym(body.ticker ?? null);
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  switch (body.action) {
    case "add-note": {
      const name = (body.name ?? "").trim().slice(0, 140);
      const content = (body.content ?? "").trim().slice(0, 40_000);
      if (!name || !content) {
        return NextResponse.json({ error: "name and content required" }, { status: 400 });
      }
      let folderId = desk.folders?.[ticker] ?? null;
      if (!folderId) {
        folderId = await ensureCompanyFolder(desk.email, ticker);
        if (folderId) await setCompanyFolder(userId, ticker, folderId);
      }
      if (!folderId) return NextResponse.json({ error: "no company file" }, { status: 502 });
      const ok = await addEvidenceNote(desk.email, folderId, name, content);
      return NextResponse.json({ ok });
    }
    case "update-note": {
      if (!body.docId) return NextResponse.json({ error: "docId required" }, { status: 400 });
      const ok = await updateNote(desk.email, body.docId, {
        ...(body.name ? { name: body.name.trim().slice(0, 140) } : {}),
        ...(body.content != null ? { content: body.content.slice(0, 40_000) } : {}),
      });
      return NextResponse.json({ ok });
    }
    case "file-filing": {
      const url = body.url ?? "";
      const form = (body.formLabel ?? "").slice(0, 12);
      const date = (body.date ?? "").slice(0, 10);
      if (!/^https:\/\/www\.sec\.gov\/Archives\//.test(url) || !form || !date) {
        return NextResponse.json({ error: "invalid filing" }, { status: 400 });
      }
      let folderId = desk.folders?.[ticker] ?? null;
      if (!folderId) {
        folderId = await ensureCompanyFolder(desk.email, ticker);
        if (folderId) await setCompanyFolder(userId, ticker, folderId);
      }
      if (!folderId) return NextResponse.json({ error: "no company file" }, { status: 502 });
      const text = await fetchFilingText(url);
      const md = [
        `# ${form} — ${ticker} · filed ${date}`,
        ``,
        `- ${(body.title ?? "filing").slice(0, 160)}`,
        `- Official document: ${url}`,
        ``,
        text ? `## Filing text (extract)\n\n${text}` : `_Text extraction unavailable — read at the link above._`,
        ``,
        `_From the company's official SEC record via EDGAR._`,
      ].join("\n");
      const ok = await addEvidenceNote(desk.email, folderId, `${form} — ${date} · ${ticker}`, md);
      return NextResponse.json({ ok });
    }
    case "set-excluded": {
      const excluded = Array.isArray(body.excluded) ? body.excluded : [];
      await setContextExclude(userId, ticker, excluded);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
