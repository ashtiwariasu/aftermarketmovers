import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import {
  claimNoteDelivery,
  completeNoteDelivery,
  failNoteDelivery,
  listAllDesks,
  isDeskServiceActive,
  setCompanyFolder,
  type Desk,
} from "@/lib/desk";
import { composeDoorbell, expectedDailyTrackingDate } from "@/lib/doorbell";
import { sendEmail } from "@/lib/email";
import { ensureCompanyFolder, addEvidenceNote } from "@/lib/companyFile";
import { getTickerSnapshot } from "@/lib/ticker";
import { getTickerNews, newsStamp, daysToEvent } from "@/lib/news";
import { getCouncilPage } from "@/lib/council";
import { storyFor } from "@/lib/story";
import {
  dossierCards,
  dossierReleaseValidationError,
  getCachedDossier,
} from "@/lib/dossier";
import { cronTokenAuthorized } from "@/lib/cronAuth";
import {
  globalMorningNoteSlot,
  morningNoteRunStatus,
} from "@/lib/morningNoteCron";

export const maxDuration = 1500;

// Runs once at 09:00 America/New_York via Cloud Scheduler. Every subscribed
// desk is composed from the same market-wide capture time and New York
// research date. Member timezones and legacy noteTime preferences do not schedule
// separate research snapshots or sends.

function idempotencyKey(deskId: string, slotDate: string, artifactKey: string): string {
  const digest = createHash("sha256")
    .update(`${deskId}\n${slotDate}\n${artifactKey}`)
    .digest("hex");
  return `amm-note-${digest}`;
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        await visit(values[index]);
      }
    }),
  );
}

function pct(v: number | null): string {
  if (v == null) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** File today's evidence into each company's llmcouncil library folder —
 *  the same store the room's council reads via library_context. */
async function fileCompanyEvidence(desk: Desk, localDate: string): Promise<void> {
  for (const sym of desk.tickers) {
    try {
      let folderId = desk.folders?.[sym] ?? null;
      if (!folderId) {
        folderId = await ensureCompanyFolder(desk.email, sym);
        if (folderId) await setCompanyFolder(desk.id, sym, folderId);
      }
      if (!folderId) continue;

      const [snap, news] = await Promise.all([
        getTickerSnapshot(sym),
        getTickerNews(sym, 3),
      ]);
      if (!snap) continue;

      const lines = [
        `# ${sym} desk evidence — ${localDate}`,
        ``,
        `## Tape`,
        `- Close $${snap.price?.toFixed(2) ?? "n/a"} (prev $${snap.previousClose?.toFixed(2) ?? "n/a"}), ${pct(snap.dayChangePercent)} on the day, ${
          snap.afterHoursChangePercent != null
            ? `${pct(snap.afterHoursChangePercent)} after hours`
            : "after hours quiet"
        }.`,
        `- Volume ${snap.volume ? `${(snap.volume / 1e6).toFixed(1)}M` : "n/a"} · 52-week ${snap.fiftyTwoWeekLow?.toFixed(0) ?? "?"}–${snap.fiftyTwoWeekHigh?.toFixed(0) ?? "?"}.`,
        ``,
        ...(news.length > 0
          ? [
              `## Wires`,
              ...news.map((n) => `- ${n.title} (${n.publisher}, ${newsStamp(n.at)})`),
              ``,
            ]
          : []),
        ...(snap.nextEvent ? [`## Calendar`, `- Next company event: ${snap.nextEvent}.`, ``] : []),
        `_Filed by the AMM desk. Factual desk evidence for research framing only._`,
      ];
      await addEvidenceNote(
        desk.email,
        folderId,
        `${sym} evidence — ${localDate}`,
        lines.join("\n")
      );

      // Version the dossier cards: council-authored when today's dossier is
      // cached (the dossiers cron runs ahead of note time); template story as
      // the fallback so the deck never goes stale.
      const dossier = await getCachedDossier(sym);
      if (
        dossier &&
        dossier.date === localDate &&
        dossierReleaseValidationError(dossier) === null
      ) {
        for (const card of dossierCards(dossier)) {
          await addEvidenceNote(desk.email, folderId, card.name, card.content);
        }
      } else {
        const day = Math.abs(snap.dayChangePercent ?? 0);
        const ah = Math.abs(snap.afterHoursChangePercent ?? 0);
        await addEvidenceNote(
          desk.email,
          folderId,
          `Story — ${localDate}`,
          storyFor(snap, getCouncilPage(sym), daysToEvent(snap.nextEvent), ah >= 1.5 || day >= 2.5)
        );
      }
    } catch {
      // Evidence filing must never block the Morning Note run.
    }
  }
}

export async function POST(req: NextRequest) {
  if (!cronTokenAuthorized(process.env.CRON_TOKEN, req.headers.get("x-cron-token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // force: send one desk right now — verification hook.
  // broadcastCurrent: deliver the already-published research to every
  // subscribed desk without invoking any dossier/research generation.
  let force = "";
  let forceOutcome: "no-thesis" | undefined;
  let forceDesign: "clear-axis" | undefined;
  let broadcastCurrent = false;
  try {
    const body = (await req.json()) as unknown;
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    const record = (body ?? {}) as {
      force?: unknown;
      forceOutcome?: unknown;
      forceDesign?: unknown;
      broadcastCurrent?: unknown;
    };
    if (record.force !== undefined && typeof record.force !== "string") {
      return NextResponse.json({ error: "force must be a desk id" }, { status: 400 });
    }
    force = (record.force ?? "").trim();
    if (record.forceOutcome !== undefined && record.forceOutcome !== "no-thesis") {
      return NextResponse.json({ error: "invalid forceOutcome" }, { status: 400 });
    }
    if (record.forceOutcome === "no-thesis") forceOutcome = "no-thesis";
    if (record.forceDesign !== undefined && record.forceDesign !== "clear-axis") {
      return NextResponse.json({ error: "invalid forceDesign" }, { status: 400 });
    }
    if (record.forceDesign === "clear-axis") forceDesign = "clear-axis";
    if (record.broadcastCurrent !== undefined && typeof record.broadcastCurrent !== "boolean") {
      return NextResponse.json({ error: "broadcastCurrent must be a boolean" }, { status: 400 });
    }
    broadcastCurrent = record.broadcastCurrent === true;
  } catch {
    /* no body */
  }
  if (forceOutcome && !force) {
    return NextResponse.json(
      { error: "forceOutcome requires an explicit force desk id" },
      { status: 400 },
    );
  }
  if (forceDesign && !force) {
    return NextResponse.json(
      { error: "forceDesign requires an explicit force desk id" },
      { status: 400 },
    );
  }
  if (broadcastCurrent && (force || forceOutcome || forceDesign)) {
    return NextResponse.json(
      { error: "broadcastCurrent cannot be combined with force options" },
      { status: 400 },
    );
  }

  const capturedAt = new Date();
  const globalSlot = globalMorningNoteSlot(capturedAt);
  const trackingDate = expectedDailyTrackingDate(capturedAt);
  if (!force && !broadcastCurrent && !globalSlot.due) {
    return NextResponse.json({
      desks: 0,
      considered: 0,
      claimedElsewhere: 0,
      sent: 0,
      forceMatched: false,
      broadcastCurrent: false,
      deliveryDate: globalSlot.date,
      trackingDate,
      skipped: "outside-global-pre-open-window",
      errors: [],
    });
  }

  const desks = await listAllDesks();
  // Capture the market tape once before composing any desk. Dossiers and
  // daily receipts are immutable by date; this removes the remaining live
  // per-recipient read that could otherwise drift during a large send.
  const capturedSnapshots = new Map<string, NonNullable<Awaited<ReturnType<typeof getTickerSnapshot>>>>();
  const fleetTickers = [...new Set(desks.flatMap((desk) =>
    desk.tickers.map((ticker) => ticker.trim().toUpperCase()),
  ))].filter((ticker) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker));
  await forEachConcurrent(fleetTickers, 8, async (ticker) => {
    const snapshot = await getTickerSnapshot(ticker).catch(() => null);
    if (snapshot) capturedSnapshots.set(ticker, snapshot);
  });
  const capturedSnapshotList = [...capturedSnapshots.values()];
  let sent = 0;
  let considered = 0;
  let claimedElsewhere = 0;
  let forceMatched = false;
  const errors: string[] = [];
  const deliveredForFiling: Desk[] = [];

  await forEachConcurrent(desks, 4, async (desk) => {
    const forced = force !== "" && desk.id === force;
    if (force !== "" && !forced) return;
    if (forced) forceMatched = true;
    // A deleted/deactivated account keeps its desk and research history, but
    // it no longer participates in the company fleet or receives deliveries.
    if (desk.researchActive === false) {
      if (forced || broadcastCurrent) errors.push(`${desk.id}: desk research is inactive`);
      return;
    }
    if (!desk.email || desk.tickers.length === 0) {
      if (forced || broadcastCurrent) errors.push(`${desk.id}: desk has no deliverable email or tickers`);
      return;
    }
    // A force render is an operator diagnostic. Every member-facing path,
    // including broadcast retries, respects the subscription gate.
    if (!forced && !isDeskServiceActive(desk)) return;
    if (desk.emailOptOut) {
      if (forced) errors.push(`${desk.id}: forced desk is unsubscribed`);
      return; // unsubscribed — desk still works, email stops
    }
    if (!forced && !broadcastCurrent) {
      if (desk.lastNoteDate === globalSlot.date) return;
    }
    considered++;
    const slotDate = globalSlot.date;
    const attemptId = randomUUID();
    if (!forced && !broadcastCurrent && !(await claimNoteDelivery(desk.id, slotDate, attemptId))) {
      claimedElsewhere++;
      return;
    }

    try {
      // The doorbell owns both outcomes: a thesis that cleared the five-seat
      // gate, or the honest fixed-format no-new-thesis note.
      const note = await composeDoorbell(
        desk,
        forced
          ? { forceOutcome, now: capturedAt, snapshots: capturedSnapshotList }
          : broadcastCurrent
            ? { repeatPublished: true, trackingDate, now: capturedAt, snapshots: capturedSnapshotList }
            : { trackingDate, now: capturedAt, snapshots: capturedSnapshotList },
      );
      if (!note) throw new Error("empty desk cannot compose a Morning Note");
      const resendKey = forced
        ? idempotencyKey(desk.id, slotDate, `force:${attemptId}:${note.artifactKey}`)
        : broadcastCurrent
          ? idempotencyKey(desk.id, slotDate, `broadcast:signal-rail-v1:${note.artifactKey}`)
          : idempotencyKey(desk.id, slotDate, note.publishedDossierKey ?? "no-thesis");
      const deliverySubject = forced
        ? `[RENDER${forceDesign === "clear-axis" ? " CLEAR AXIS" : ""} ${globalSlot.hhmm} ET ${attemptId.slice(0, 4).toUpperCase()}] ${note.subject}`
        : note.subject;
      const deliveryHeaders = forced
        ? { ...note.headers, "X-Entity-Ref-ID": attemptId }
        : note.headers;
      const ok = await sendEmail(
        desk.email,
        deliverySubject,
        note.html,
        note.text,
        deliveryHeaders,
        resendKey,
      );
      if (ok) {
        if (forced || broadcastCurrent) {
          sent++;
        } else {
          const committed = await completeNoteDelivery(
            desk.id,
            slotDate,
            attemptId,
            note.artifactKey,
            note.publishedDossierKey,
          );
          if (!committed) {
            errors.push(`${desk.id}: provider accepted but delivery state was not committed`);
            return;
          }
          sent++;
          deliveredForFiling.push(desk);
        }
      } else {
        if (!forced && !broadcastCurrent) {
          await failNoteDelivery(desk.id, slotDate, attemptId, "provider did not accept email");
        }
        errors.push(`${desk.id}: send failed`);
      }
    } catch (e) {
      if (!forced && !broadcastCurrent) {
        await failNoteDelivery(desk.id, slotDate, attemptId, String(e));
      }
      errors.push(`${desk.id}: ${String(e).slice(0, 120)}`);
    }
  });

  // Delivery is the critical path. Only after every eligible desk has had its
  // first send attempt do we file supporting evidence, with bounded
  // concurrency and no effect on the delivery result.
  await forEachConcurrent(deliveredForFiling, 2, async (desk) => {
    await fileCompanyEvidence(desk, trackingDate).catch(() => undefined);
  });

  const status = morningNoteRunStatus({ force, forceMatched, sent, errors });
  return NextResponse.json(
    {
      desks: desks.length,
      considered,
      claimedElsewhere,
      sent,
      forceMatched,
      broadcastCurrent,
      deliveryDate: globalSlot.date,
      trackingDate,
      errors,
    },
    { status },
  );
}
