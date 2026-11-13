import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDesk, isDeskServiceActive, setCompanyFolder } from "@/lib/desk";
import {
  ensureCompanyFolder,
  listFolderDocs,
  addEvidenceNote,
} from "@/lib/companyFile";
import { dossierReleaseValidationError, ensureDossier, dossierCards } from "@/lib/dossier";
import { getFundamentalsStored } from "@/lib/companyStore";
import { fundamentalsMd } from "@/lib/sec";
import { assessResearchSupport } from "@/lib/researchSupport";

export const maxDuration = 300;

function etDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** First-touch provisioning for a newly picked company: populate the
 *  canonical store, generate the first dossier, and file the opening cards
 *  into the member's company file — so the file page lands warm. */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk" }, { status: 404 });
  if (!isDeskServiceActive(desk)) return NextResponse.json({ error: "AMM subscription required" }, { status: 402 });

  let body: { ticker?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const sym = (body.ticker ?? "").toUpperCase().trim();
  if (!desk.tickers.includes(sym)) {
    return NextResponse.json({ error: "not on your watch" }, { status: 400 });
  }
  const support = await assessResearchSupport(sym);
  if (!support.supported) {
    return NextResponse.json(
      { error: support.message, code: "STOCK_NOT_SUPPORTED", support },
      { status: support.code === "verification_unavailable" ? 503 : 422 },
    );
  }

  // 1. The company file (llmcouncil folder).
  let folderId = desk.folders?.[sym] ?? null;
  if (!folderId) {
    folderId = await ensureCompanyFolder(desk.email, sym);
    if (folderId) await setCompanyFolder(userId, sym, folderId);
  }

  // 2. First dossier (also write-throughs bars/filings/fundamentals into the
  //    canonical store via the context builder). Cached => instant.
  const today = etDate();
  const dossier = await ensureDossier(sym, today);
  if (!dossier || dossier.date !== today || dossierReleaseValidationError(dossier) !== null) {
    return NextResponse.json(
      {
        error: "Today's full research did not clear AMM's release checks. The last valid dossier remains archived, but it is not being presented as current.",
        code: "RESEARCH_NOT_READY",
        ticker: sym,
      },
      { status: 503 },
    );
  }

  // 3. File the opening documents, skipping anything already on file.
  let filed = 0;
  if (folderId) {
    const existing = await listFolderDocs(desk.email, folderId);
    const has = (name: string) => existing.some((d) => d.name === name);

    if (dossier) {
      for (const card of dossierCards(dossier)) {
        if (!has(card.name)) {
          const ok = await addEvidenceNote(desk.email, folderId, card.name, card.content);
          if (ok) filed++;
        }
      }
    }
    const fundamentals = await getFundamentalsStored(sym);
    if (fundamentals) {
      const name = `Fundamentals — ${sym} · ${fundamentals.asOf}`;
      if (!existing.some((d) => d.name.startsWith(`Fundamentals — ${sym}`))) {
        const ok = await addEvidenceNote(desk.email, folderId, name, fundamentalsMd(sym, fundamentals));
        if (ok) filed++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    ticker: sym,
    folder: Boolean(folderId),
    dossier: dossier ? { date: dossier.date, headline: dossier.headline } : null,
    filed,
  });
}
