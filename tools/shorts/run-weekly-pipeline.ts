#!/usr/bin/env tsx
/**
 * Latest completed dossier fleet → one 5–6-stock non-trading-day briefing.
 *
 * Saturday is the weekly review. Sundays and NYSE holidays are the week-ahead
 * edition. The selector is read-only by default; --render crosses the editor,
 * verifier and HeyGen boundaries, and --publish additionally schedules the
 * passing result on YouTube.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Firestore } from "@google-cloud/firestore";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getDossierTerminalFailure,
  getRejectedDossierFactualUpdate,
  type Dossier,
} from "../../src/lib/dossier";
import { listActiveCompanyTickers } from "../../src/lib/companyFleet";
import {
  SHORTS_CELEBRITY_UNIVERSE,
  dailyShortArtifactKey,
} from "../../src/lib/dailyShorts";
import { getDossierHistory } from "../../src/lib/companyStore";
import { getTickerSnapshot } from "../../src/lib/ticker";
import {
  isUsEquityTradingDay,
  previousUsEquityTradingDay,
  publishYouTubeWeeklyShort,
  weekendRecapPublicationSlot,
} from "../../src/lib/shortPublishing";
import {
  weeklyShortPackageValidationError,
  type WeeklyShortEpisodePackage,
} from "../../src/lib/weeklyShortEpisode";
import {
  selectWeeklyShortStocks,
  weeklyShortEditionForPublicationDate,
  type WeeklyShortSelection,
} from "../../src/lib/weeklyShorts";
import {
  shortPublicationIsHandled,
  type ShortPublicationRecord,
} from "../../src/lib/shortPublication";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || undefined;
const EXPECTED_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID ?? "";
const ARTIFACT_ROOT = process.env.AMM_SHORT_ARTIFACT_ROOT ??
  path.resolve("tools/shorts/daily-artifacts");
const RENDER_ROOT = process.env.AMM_SHORT_OUTPUT_ROOT ??
  path.join(ARTIFACT_ROOT, "renders");
const DAILY_RUN_COLLECTION = "daily_short_runs";
const PUBLICATION_COLLECTION = "short_publications";
const RUN_SCHEMA = "amm-weekly-short-run-v1";
const PROCESSING_LEASE_MS = 6 * 60 * 60_000;
const db = new Firestore({ projectId: PROJECT_ID });
let currentRunId = "unknown-weekly-short";
let alertFailures = false;

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function after(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function etDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function previousCalendarDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicationId(artifactKey: string): string {
  return digest(artifactKey).slice(0, 48);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

async function run(command: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}

async function completedDossiers(
  targetDate: string,
): Promise<{
  dossiers: Dossier[];
  rejected: string[];
  failed: string[];
  missing: string[];
  historyStartDate: string;
  historyByTicker: Record<string, Dossier[]>;
  nextEventByTicker: Record<string, string | null>;
}> {
  let historyStartDate = targetDate;
  for (let index = 0; index < 4; index += 1) {
    historyStartDate = previousUsEquityTradingDay(historyStartDate);
  }
  const tickers = (await listActiveCompanyTickers())
    .filter((symbol) => Object.hasOwn(SHORTS_CELEBRITY_UNIVERSE, symbol))
    .sort((left, right) => left.localeCompare(right));
  const states = await Promise.all(tickers.map(async (ticker) => {
    const [dossier, rejected, terminal, storedHistory, snapshot] = await Promise.all([
      getCachedDossier(ticker).catch(() => null),
      getRejectedDossierFactualUpdate(ticker, targetDate).catch(() => null),
      getDossierTerminalFailure(ticker, targetDate).catch(() => null),
      getDossierHistory<Dossier>(ticker, 12).catch(() => []),
      getTickerSnapshot(ticker).catch(() => null),
    ]);
    const history = storedHistory.filter((observation) =>
      typeof observation?.date === "string" &&
      typeof observation?.ticker === "string" &&
      observation.date >= historyStartDate &&
      observation.date <= targetDate &&
      observation.ticker.toUpperCase() === ticker &&
      dossierReleaseValidationError(observation) === null);
    const released = [
      ...(dossier ? [dossier] : []),
      ...history,
    ]
      .filter((observation) =>
        observation.date >= historyStartDate &&
        observation.date <= targetDate &&
        observation.ticker.toUpperCase() === ticker &&
        dossierReleaseValidationError(observation) === null)
      .sort((left, right) =>
        right.date.localeCompare(left.date) ||
        right.generatedAt - left.generatedAt);
    const latestReleased = released[0] ?? null;
    if (latestReleased) {
      return {
        ticker,
        dossier: latestReleased,
        history,
        nextEvent: snapshot?.nextEvent ?? null,
        status: "ready" as const,
      };
    }
    if (rejected) {
      return { ticker, dossier: null, history, nextEvent: null, status: "rejected" as const };
    }
    if (terminal) {
      return { ticker, dossier: null, history, nextEvent: null, status: "failed" as const };
    }
    return { ticker, dossier: null, history, nextEvent: null, status: "missing" as const };
  }));
  return {
    dossiers: states.flatMap((state) => state.dossier ? [state.dossier] : []),
    rejected: states.filter((state) => state.status === "rejected").map((state) => state.ticker),
    failed: states.filter((state) => state.status === "failed").map((state) => state.ticker),
    missing: states.filter((state) => state.status === "missing").map((state) => state.ticker),
    historyStartDate,
    historyByTicker: Object.fromEntries(
      states.map((state) => [state.ticker, state.history]),
    ),
    nextEventByTicker: Object.fromEntries(
      states.map((state) => [state.ticker, state.nextEvent]),
    ),
  };
}

async function immutableSelection(
  proposed: WeeklyShortSelection,
): Promise<WeeklyShortSelection> {
  const ref = db.collection(DAILY_RUN_COLLECTION).doc(currentRunId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) {
      const stored = snapshot.data() as {
        schema?: string;
        selection?: WeeklyShortSelection;
      };
      if (stored.schema !== RUN_SCHEMA || stored.selection?.schema !== proposed.schema) {
        throw new Error(`unsupported stored weekly Shorts run for ${currentRunId}`);
      }
      // A failed preflight has no paid or published artifact. Allow a later
      // corrected selector to recover the same edition while preserving an
      // already-qualified immutable selection.
      if (!stored.selection.eligible && proposed.eligible) {
        transaction.update(ref, {
          status: "selected",
          selection: proposed,
          recoveredAt: Date.now(),
        });
        return proposed;
      }
      return stored.selection;
    }
    transaction.create(ref, {
      schema: RUN_SCHEMA,
      targetDate: proposed.targetDate,
      publicationDate: proposed.publicationDate,
      edition: proposed.edition,
      status: proposed.eligible ? "selected" : "no-qualified-review",
      createdAt: Date.now(),
      selection: proposed,
    });
    return proposed;
  });
}

function weeklyArtifactKey(selection: WeeklyShortSelection): string {
  return [
    "weekly",
    selection.publicationDate,
    selection.edition,
    ...selection.selected.map((stock) => stock.artifactKey),
  ].join(":");
}

async function claimPublication(
  selection: WeeklyShortSelection,
): Promise<{
  claimed: boolean;
  id: string;
  previous?: Record<string, unknown>;
}> {
  const artifactKey = weeklyArtifactKey(selection);
  const id = publicationId(artifactKey);
  const ref = db.collection(PUBLICATION_COLLECTION).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.data() as Record<string, unknown> | undefined;
    if (shortPublicationIsHandled(previous)) {
      return { claimed: false, id, previous };
    }
    transaction.set(ref, {
      schema: "amm-weekly-short-publication-v1",
      artifactKey,
      targetDate: selection.targetDate,
      publicationDate: selection.publicationDate,
      edition: selection.edition,
      tickers: selection.selected.map((stock) => stock.ticker),
      dossierArtifactKeys: selection.selected.map((stock) => stock.artifactKey),
      status: "processing",
      claimedAt: Date.now(),
      leaseExpiresAt: Date.now() + PROCESSING_LEASE_MS,
      attempts: Number(previous?.attempts ?? 0) + 1,
    }, { merge: true });
    return { claimed: true, id, previous };
  });
}

async function existingPublication(
  selection: WeeklyShortSelection,
): Promise<{ id: string; previous: ShortPublicationRecord } | null> {
  const artifactKey = weeklyArtifactKey(selection);
  const id = publicationId(artifactKey);
  const snapshot = await db.collection(PUBLICATION_COLLECTION).doc(id).get();
  const previous = snapshot.data() as ShortPublicationRecord;
  return shortPublicationIsHandled(previous) ? { id, previous } : null;
}

async function updatePublication(id: string, patch: Record<string, unknown>): Promise<void> {
  await db.collection(PUBLICATION_COLLECTION).doc(id).set({
    ...patch,
    updatedAt: Date.now(),
  }, { merge: true });
}

async function prepareEpisode(
  selection: WeeklyShortSelection,
  dossiers: Dossier[],
  nextEventByTicker: Record<string, string | null>,
): Promise<{
  episode: WeeklyShortEpisodePackage;
  packageDir: string;
  finalVideo: string;
  qcPath: string;
}> {
  const packageDir = path.join(
    ARTIFACT_ROOT,
    "packages",
    "weekly",
    selection.publicationDate,
    selection.edition,
  );
  const packagePath = path.join(packageDir, "episode-package.json");
  const dossiersPath = path.join(packageDir, "dossiers.json");
  const verifierPath = path.join(packageDir, "verifier-receipt.json");
  const nextEventsPath = path.join(packageDir, "next-events.json");
  const renderDir = path.join(
    RENDER_ROOT,
    `weekly-${selection.publicationDate}-${selection.edition}`,
  );
  const finalVideo = path.join(
    RENDER_ROOT,
    `weekly-${selection.publicationDate}-${selection.edition}-FINISHED.mp4`,
  );
  const qcPath = path.join(renderDir, "qc-receipt.json");
  await Promise.all([
    mkdir(packageDir, { recursive: true }),
    mkdir(RENDER_ROOT, { recursive: true }),
  ]);
  await writeFile(dossiersPath, `${JSON.stringify(dossiers, null, 2)}\n`);
  await writeFile(nextEventsPath, `${JSON.stringify(nextEventByTicker, null, 2)}\n`);

  let forceNewRender = false;
  if (await exists(packagePath)) {
    const episode = await readFile(packagePath, "utf8")
      .then((value) => JSON.parse(value) as WeeklyShortEpisodePackage);
    forceNewRender =
      weeklyShortPackageValidationError(dossiers, episode, nextEventByTicker) !== null;
  }
  if (!(await exists(packagePath)) || forceNewRender) {
    await run("npx", [
      "tsx",
      "tools/shorts/draft-weekly-short.ts",
      "--dossiers",
      dossiersPath,
      "--target-date",
      selection.targetDate,
      "--publication-date",
      selection.publicationDate,
      "--edition",
      selection.edition,
      "--next-events",
      nextEventsPath,
      "--out",
      packageDir,
    ]);
  }
  const episode = await readFile(packagePath, "utf8")
    .then((value) => JSON.parse(value) as WeeklyShortEpisodePackage);
  const packageError =
    weeklyShortPackageValidationError(dossiers, episode, nextEventByTicker);
  if (packageError) throw new Error(`weekly package failed final binding: ${packageError}`);
  if (!(await exists(verifierPath))) {
    throw new Error("weekly package has no independent verifier receipt");
  }
  await run(
    "tools/shorts/make-weekly-episode.sh",
    [packagePath, ...(forceNewRender ? ["--force-new-render"] : [])],
    { ...process.env, AMM_SHORT_OUTPUT_ROOT: RENDER_ROOT },
  );
  const qc = await readFile(qcPath, "utf8").then((value) =>
    JSON.parse(value) as { status?: string; videoSha256?: string });
  if (qc.status !== "pass" || !/^[a-f0-9]{64}$/.test(qc.videoSha256 ?? "")) {
    throw new Error("weekly media has no passing QC receipt");
  }
  if (!(await exists(finalVideo))) throw new Error("weekly final video is missing");
  return { episode, packageDir, finalVideo, qcPath };
}

function oauthCredentials(): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} {
  const clientId = process.env.YOUTUBE_CLIENT_ID ?? "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN are required to publish",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

async function sendFailureAlert(error: unknown): Promise<void> {
  const key = process.env.RESEND_API_KEY ?? "";
  if (!key) {
    console.error("[weekly-shorts] RESEND_API_KEY unavailable; failure email not sent");
    return;
  }
  const message = String(error).slice(0, 4_000);
  const fingerprint = digest(`${currentRunId}:${message}`);
  const ref = db.collection(DAILY_RUN_COLLECTION).doc(currentRunId);
  const shouldSend = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() as {
      failureAlertFingerprint?: string;
      failureAlertedAt?: number;
    } | undefined;
    if (
      data?.failureAlertFingerprint === fingerprint &&
      Number(data.failureAlertedAt ?? 0) > Date.now() - 4 * 60 * 60_000
    ) return false;
    transaction.set(ref, {
      failureAlertFingerprint: fingerprint,
      failureAlertedAt: Date.now(),
    }, { merge: true });
    return true;
  }).catch(() => true);
  if (!shouldSend) return;
  const alertTo = process.env.SHORTS_ALERT_EMAIL ?? "";
  if (!alertTo) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "AMM <desk@aftermarketmovers.com>",
      to: [alertTo],
      subject: `AMM weekly Short failed · ${currentRunId}`,
      text:
        `The AMM 5–6-stock non-trading-day briefing failed.\n\n${message}\n\n` +
        "No incomplete, stale, weak or mismatched video was published.",
    }),
  });
  if (!response.ok) {
    console.error(`[weekly-shorts] failure email rejected: ${response.status}`);
  }
}

async function main(): Promise<void> {
  const publishNow = has("--publish-now");
  const publish = publishNow || has("--publish");
  const render = publish || has("--render");
  alertFailures = render;
  const publicationDate = etDate();
  if (isUsEquityTradingDay(publicationDate)) {
    throw new Error(`weekly briefing runs only on non-trading days: ${publicationDate}`);
  }
  // Weekend research may be finalized after Friday's close and stamped on
  // Saturday. Use the immediately completed research day, not merely the prior
  // exchange session, or the freshest valid dossiers are incorrectly hidden.
  const defaultTargetDate = previousCalendarDate(publicationDate);
  const targetDate = after("--target-date") ?? defaultTargetDate;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("invalid --target-date");
  }
  const expectedTarget = defaultTargetDate;
  if (targetDate !== expectedTarget && (render || publish)) {
    throw new Error(
      `stale weekly research forbidden: expected ${expectedTarget}, received ${targetDate}`,
    );
  }
  const edition = weeklyShortEditionForPublicationDate(publicationDate);
  currentRunId = `${publicationDate}-${edition}`;
  const state = await completedDossiers(targetDate);
  const proposed = selectWeeklyShortStocks({
    dossiers: state.dossiers,
    targetDate,
    publicationDate,
    edition,
    minimumDossierDate: state.historyStartDate,
    historyByTicker: state.historyByTicker,
  });
  const selection = render ? await immutableSelection(proposed) : proposed;
  console.log(JSON.stringify({
    mode: publish ? "publish" : render ? "render" : "select-only",
    targetDate,
    publicationDate,
    edition,
    rejected: state.rejected,
    terminalFailures: state.failed,
    missing: state.missing,
    selected: selection.selected.map((stock) => ({
      ticker: stock.ticker,
      lifecycleStatus: stock.lifecycleStatus,
      signal: `${stock.signal.strength} ${
        stock.signal.direction === "UP" ? "UPSIDE" : "DOWNSIDE"
      }`,
      support: stock.votes.support,
      score: stock.editorialStrength.score,
      weeklyMovement: stock.weeklyMovement,
    })),
    withheld: selection.assessments
      .filter((stock) => !stock.eligible)
      .map((stock) => ({ ticker: stock.ticker, reasons: stock.reasons })),
    reason: selection.reason,
  }, null, 2));
  if (!render) return;
  if (!selection.eligible || selection.selected.length < 5) {
    await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
      status: "no-qualified-review",
      completedAt: Date.now(),
      reason: selection.reason,
    }, { merge: true });
    return;
  }
  const dossierByArtifact = new Map(
    state.dossiers.map((dossier) => [dailyShortArtifactKey(dossier), dossier]),
  );
  const dossiers = selection.selected.map((stock) => {
    const dossier = dossierByArtifact.get(stock.artifactKey);
    if (!dossier) {
      throw new Error(`immutable weekly selection lost ${stock.ticker}`);
    }
    return dossier;
  });
  // A retry after the same-day publication window must be an inexpensive,
  // successful no-op when this exact immutable edition is already scheduled
  // or published. Check before enforcing the window so late scheduler retries
  // do not turn a completed publication into a false incident.
  const existing = await existingPublication(selection);
  if (existing) {
    console.log(JSON.stringify({
      alreadyHandled: true,
      videoId: existing.previous?.videoId ?? null,
      publishAt: existing.previous?.publishAt ?? null,
    }, null, 2));
    return;
  }
  // A manual render may happen at any time. Only publishing is constrained to
  // the fixed pre-market slot, and that check must happen before paid media
  // generation rather than after it.
  const publishAt = publish
    ? (
      publishNow
        ? new Date(Date.now() + 20 * 60_000)
        : weekendRecapPublicationSlot({ publicationDate })
    )
    : null;
  const claim = await claimPublication(selection);
  if (!claim.claimed) {
    console.log(JSON.stringify({
      alreadyHandled: true,
      videoId: claim.previous?.videoId ?? null,
      publishAt: claim.previous?.publishAt ?? null,
    }, null, 2));
    return;
  }
  try {
    const selectedNextEvents = Object.fromEntries(
      dossiers.map((dossier) => [
        dossier.ticker.toUpperCase(),
        state.nextEventByTicker[dossier.ticker.toUpperCase()] ?? null,
      ]),
    );
    const prepared = await prepareEpisode(selection, dossiers, selectedNextEvents);
    await updatePublication(claim.id, {
      status: publish ? "uploading" : "rendered",
      episodeId: prepared.episode.episodeId,
      sourceBundleSha256: prepared.episode.provenance.sourceBundleSha256,
      sourceCitations: prepared.episode.provenance.citations,
      packageDir: prepared.packageDir,
      finalVideo: prepared.finalVideo,
      qcPath: prepared.qcPath,
      publishAt: publishAt?.toISOString() ?? null,
    });
    if (!publish) {
      await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
        status: "rendered",
        completedAt: Date.now(),
        episodeId: prepared.episode.episodeId,
        finalVideo: prepared.finalVideo,
      }, { merge: true });
      return;
    }
    if (!publishAt) throw new Error("weekly publish slot was not established");
    const video = await publishYouTubeWeeklyShort({
      credentials: oauthCredentials(),
      episode: prepared.episode,
      videoPath: prepared.finalVideo,
      publishAt,
      expectedChannelId: EXPECTED_CHANNEL_ID,
      onUploadSession: async (uploadSessionUrl) => {
        await updatePublication(claim.id, { status: "uploading", uploadSessionUrl });
      },
    });
    await updatePublication(claim.id, {
      status: video.status?.privacyStatus === "public" ? "published" : "scheduled",
      videoId: video.id,
      publishAt: video.status?.publishAt ?? publishAt.toISOString(),
      youtubePrivacyStatus: video.status?.privacyStatus ?? "private",
      uploadSessionUrl: null,
      leaseExpiresAt: null,
      scheduledAt: Date.now(),
    });
    await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
      status: "scheduled",
      completedAt: Date.now(),
      episodeId: prepared.episode.episodeId,
      videoId: video.id,
      publishAt: video.status?.publishAt ?? publishAt.toISOString(),
    }, { merge: true });
  } catch (error) {
    await updatePublication(claim.id, {
      status: "failed",
      error: String(error).slice(0, 2_000),
      failedAt: Date.now(),
      leaseExpiresAt: null,
    }).catch(() => {});
    throw error;
  }
}

main().catch(async (error) => {
  console.error(error);
  if (alertFailures) {
    try {
      await sendFailureAlert(error);
    } catch (alertError) {
      console.error(`[weekly-shorts] failure alert crashed: ${String(alertError)}`);
    }
  }
  process.exitCode = 1;
});
