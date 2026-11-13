/**
 * Migration guard for the v5 reader switch.
 *
 * Dry-run (default): npx tsx scripts/backfill-v5-dossiers.ts
 * Execute serially:   npx tsx scripts/backfill-v5-dossiers.ts --execute --confirm=v5
 * Verify full switch: npx tsx scripts/backfill-v5-dossiers.ts --verify
 * One retry:          ... --ticker=GOOGL --execute --confirm=v5
 */
import { FieldPath, Firestore } from "@google-cloud/firestore";
import { listAllDesks } from "../src/lib/desk";
import {
  DOSSIER_ARTIFACT_VERSION,
  dossierReleaseValidationError,
  ensureDossier,
  getCachedDossier,
  getRejectedDossierFactualUpdate,
  type Dossier,
} from "../src/lib/dossier";
import { dossierBackfillFailed, planWatchedTickerBackfill } from "../src/lib/dossierBackfill";
import {
  buildPrivateSignalOutboxItem,
  enqueuePrivateSignalOutbox,
  getPrivateSignalOutboxItem,
  type PrivateSignalOutboxItem,
} from "../src/lib/privateSignalOutbox";

const EXPECTED_VERSION = 5;
const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
if (!projectId) {
  throw new Error(
    "GOOGLE_CLOUD_PROJECT is required; refusing to migrate an ambient or accidental Firestore project",
  );
}
const db = new Firestore({ projectId });

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function etDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function ready(dossier: Awaited<ReturnType<typeof getCachedDossier>>): boolean {
  return Boolean(dossier && dossier.artifactVersion === EXPECTED_VERSION) &&
    dossierReleaseValidationError(dossier) === null;
}

/** Every historical dossier document for one watched ticker, without a cap. */
async function listDossierHistoryExhaustive(ticker: string): Promise<unknown[]> {
  const collection = db.collection("companies").doc(ticker).collection("dossiers");
  const records: unknown[] = [];
  let afterId: string | null = null;
  for (;;) {
    let query = collection.orderBy(FieldPath.documentId()).limit(500);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.get();
    records.push(...page.docs.map((document) => document.data()));
    if (page.size < 500) break;
    afterId = page.docs.at(-1)?.id ?? null;
    if (!afterId) throw new Error(`${ticker}: history pagination lost its cursor`);
  }
  return records;
}

function outboxCandidates(
  input: unknown[],
  supersededInvalidLabels: ReadonlySet<string> = new Set(),
): {
  items: PrivateSignalOutboxItem[];
  invalid: string[];
} {
  const items = new Map<string, PrivateSignalOutboxItem>();
  const invalid: string[] = [];
  const acceptedLabels = new Set(supersededInvalidLabels);
  for (const value of input) {
    const candidate = value as Partial<Dossier> | null;
    if (!candidate || candidate.artifactVersion !== EXPECTED_VERSION || !ready(candidate as Dossier)) continue;
    acceptedLabels.add(`${candidate.ticker ?? "?"}:${candidate.date ?? "?"}`);
  }
  for (const value of input) {
    const candidate = value as Partial<Dossier> | null;
    if (!candidate || candidate.artifactVersion !== EXPECTED_VERSION) continue;
    const label = `${candidate.ticker ?? "?"}:${candidate.date ?? "?"}`;
    if (!ready(candidate as Dossier)) {
      // An invalid artifact for the exact migration date is not a historical
      // predecessor: execute mode is about to replace that same immutable day
      // slot. Older invalid v5 history still fails closed.
      if (acceptedLabels.has(label)) continue;
      invalid.push(`${label}: published v5 artifact fails the exact release gate`);
      continue;
    }
    try {
      const item = buildPrivateSignalOutboxItem(candidate as Dossier);
      const existing = items.get(item.id);
      if (existing && existing.payloadSha256.digest !== item.payloadSha256.digest) {
        invalid.push(`${label}: compact outbox content-address collision`);
        continue;
      }
      items.set(item.id, item);
    } catch (error) {
      invalid.push(`${label}: ${String(error).slice(0, 240)}`);
    }
  }
  return {
    items: [...items.values()].sort((left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    invalid,
  };
}

async function main(): Promise<void> {
  if (DOSSIER_ARTIFACT_VERSION !== EXPECTED_VERSION) {
    throw new Error(
      `refusing migration: code emits dossier v${DOSSIER_ARTIFACT_VERSION}, expected v${EXPECTED_VERSION}`,
    );
  }
  const execute = process.argv.includes("--execute");
  const verify = process.argv.includes("--verify");
  if (execute && verify) throw new Error("choose either --execute or --verify");
  if (execute && argument("confirm")?.toLowerCase() !== "v5") {
    throw new Error("--execute requires the explicit guard --confirm=v5");
  }
  const requested = argument("ticker")?.trim().toUpperCase() ?? null;
  if (requested && !/^[A-Z][A-Z.\-]{0,9}$/.test(requested)) {
    throw new Error(`invalid --ticker=${requested}`);
  }
  if (process.argv.some((value) => value === "--limit" || value.startsWith("--limit="))) {
    throw new Error("--limit is forbidden: migration and verification must cover every watched ticker");
  }
  if (verify && requested) throw new Error("--verify is exhaustive and cannot be combined with --ticker");
  const date = argument("date") ?? etDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid --date=${date}`);

  const desks = await listAllDesks();
  const plan = planWatchedTickerBackfill(desks);
  if (plan.deskCount === 0 || plan.tickers.length === 0) {
    throw new Error(
      `refusing migration for ${projectId}: watched universe is empty (${plan.deskCount} desks, ${plan.tickers.length} tickers)`,
    );
  }
  const tickers = requested ? plan.tickers.filter((ticker) => ticker === requested) : plan.tickers;
  if (requested && tickers.length === 0) throw new Error(`${requested} is not watched by any desk`);
  const mode: "execute" | "verify" | "dry-run" = execute
    ? "execute"
    : verify
      ? "verify"
      : "dry-run";

  const report = {
    mode,
    projectId,
    fullCoverage: requested == null,
    artifactVersion: EXPECTED_VERSION,
    date,
    desks: plan.deskCount,
    watchedTickers: plan.tickers.length,
    invalidTickers: plan.invalidTickers,
    selected: tickers,
    alreadyReady: [] as string[],
    rejectedReady: [] as string[],
    needsBackfill: [] as string[],
    generated: [] as string[],
    failed: [] as Array<{ ticker: string; error: string }>,
    publishedV5Dossiers: 0,
    outboxAlreadyReady: [] as string[],
    outboxNeedsBackfill: [] as string[],
    outboxCreated: [] as string[],
    outboxFailed: [] as Array<{ key: string; error: string }>,
    invalidPublishedV5: [] as string[],
  };

  // Serial by design: every generation is expensive and checkpointed, and a
  // migration must not create a council-call stampede.
  for (const ticker of tickers) {
    let cached = await getCachedDossier(ticker);
    const rejectedUpdate = await getRejectedDossierFactualUpdate(ticker, date).catch(() => null);
    const seenOutboxIds = new Set<string>();
    const seenInvalid = new Set<string>();

    const reconcileOutboxes = async (
      values: unknown[],
      supersededInvalidLabels: ReadonlySet<string> = new Set(),
    ): Promise<boolean> => {
      const candidates = outboxCandidates(values, supersededInvalidLabels);
      let clean = true;
      for (const invalid of candidates.invalid) {
        if (seenInvalid.has(invalid)) continue;
        seenInvalid.add(invalid);
        report.invalidPublishedV5.push(invalid);
        clean = false;
      }
      // Candidates are oldest-first. This is required before generation:
      // ensureDossier immediately tries to materialize its current signal, and
      // that worker must already be able to see every historical predecessor.
      for (const item of candidates.items) {
        if (seenOutboxIds.has(item.id)) continue;
        seenOutboxIds.add(item.id);
        report.publishedV5Dossiers += 1;
        const key = `${item.payload.ticker}:${item.payload.date}:${item.id}`;
        try {
          const existing = await getPrivateSignalOutboxItem(item.id);
          if (existing) {
            if (existing.payloadSha256.digest !== item.payloadSha256.digest) {
              throw new Error("immutable outbox payload conflict");
            }
            report.outboxAlreadyReady.push(key);
            continue;
          }
          report.outboxNeedsBackfill.push(key);
          if (!execute) continue;
          await enqueuePrivateSignalOutbox(item);
          const verified = await getPrivateSignalOutboxItem(item.id);
          if (!verified || verified.payloadSha256.digest !== item.payloadSha256.digest) {
            throw new Error("outbox create did not verify after write");
          }
          report.outboxCreated.push(key);
        } catch (error) {
          clean = false;
          report.outboxFailed.push({ key, error: String(error).slice(0, 300) });
        }
      }
      return clean;
    };

    // Phase one is deliberately before ensureDossier. It stages every known
    // historical/current v5 hook oldest-first, so current immediate processing
    // cannot freeze calibration ahead of an earlier same-ticker signal.
    let predecessorsReady = true;
    try {
      const history = await listDossierHistoryExhaustive(ticker);
      const supersededInvalidLabels = new Set<string>();
      if (rejectedUpdate || (execute && !ready(cached))) supersededInvalidLabels.add(`${ticker}:${date}`);
      predecessorsReady = await reconcileOutboxes(
        [cached, ...history],
        supersededInvalidLabels,
      );
    } catch (error) {
      predecessorsReady = false;
      report.outboxFailed.push({
        key: `${ticker}:history-scan`,
        error: String(error).slice(0, 300),
      });
    }

    if (ready(cached)) {
      report.alreadyReady.push(ticker);
    } else if (rejectedUpdate) {
      // A five-family ballot that honestly rejects the proposition is a safe,
      // current reader state. It is not a failed or missing dossier and must
      // never be regenerated until it happens to clear consensus.
      report.rejectedReady.push(ticker);
    } else {
      report.needsBackfill.push(ticker);
      if (execute) {
        if (!predecessorsReady) {
          report.failed.push({
            ticker,
            error: "refusing current v5 generation until every historical predecessor outbox is staged",
          });
        } else {
          try {
            const generated = await ensureDossier(ticker, date);
            if (!ready(generated)) throw new Error("generation did not produce a fully cited v5 dossier");
            report.generated.push(ticker);
            cached = generated;
          } catch (error) {
            report.failed.push({ ticker, error: String(error).slice(0, 300) });
          }
        }
      }
    }

    // Phase two catches the just-generated top-level/history artifact. Every
    // predecessor was staged in phase one, and the runtime claim enforces the
    // same ordering against concurrent cron/immediate workers.
    if (execute && report.generated.includes(ticker)) {
      try {
        const history = await listDossierHistoryExhaustive(ticker);
        await reconcileOutboxes([cached, ...history]);
      } catch (error) {
        report.outboxFailed.push({
          key: `${ticker}:post-generation-history-scan`,
          error: String(error).slice(0, 300),
        });
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (dossierBackfillFailed({
    mode: report.mode,
    needsBackfill: report.needsBackfill,
    generated: report.generated,
    failed: report.failed,
    invalidTickers: report.invalidTickers,
    outboxNeedsBackfill: report.outboxNeedsBackfill,
    outboxCreated: report.outboxCreated,
    outboxFailed: report.outboxFailed,
    invalidPublishedV5: report.invalidPublishedV5,
  })) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
