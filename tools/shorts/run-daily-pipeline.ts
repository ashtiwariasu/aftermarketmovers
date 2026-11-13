#!/usr/bin/env tsx
/**
 * Completed daily dossier fleet → exactly two independently qualified public
 * Shorts → audited render → scheduled YouTube upload.
 *
 * Default mode is read-only selection. --render crosses the HeyGen paid
 * boundary. --publish additionally schedules the videos on YouTube.
 * --publish-now is an explicit operator recovery for a same-day completed
 * pair after the normal pre-market slots have passed.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Firestore } from "@google-cloud/firestore";
import { listActiveCompanyTickers } from "../../src/lib/companyFleet";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getDossierTerminalFailure,
  getRejectedDossierFactualUpdate,
  type Dossier,
} from "../../src/lib/dossier";
import {
  DAILY_SHORT_REQUIRED_COUNT,
  dailyShortArtifactKey,
  dailyShortSelectionValidationError,
  evaluateDailyShortFleetGate,
  evaluateDailyShortReadiness,
  selectDailyShorts,
  type DailyShortSelection,
} from "../../src/lib/dailyShorts";
import { getDailyThesisCheck } from "../../src/lib/dailyThesisCheck";
import {
  buildDailyShortAudienceContext,
  type StoredShortAudienceRecord,
} from "../../src/lib/shortAudience";
import {
  fetchYouTubeShortAudienceMetrics,
  isUsEquityTradingDay,
  plannedPublicationSlots,
  previousUsEquityTradingDay,
  publicationSlots,
  publishYouTubeShort,
} from "../../src/lib/shortPublishing";
import {
  shortEpisodeUsedCitationIds,
  shortEpisodeUsedCitations,
  shortPackageValidationError,
  type ShortEpisodePackage,
} from "../../src/lib/shortEpisode";
import {
  shortPublicationIsHandled,
  type ShortPublicationRecord,
} from "../../src/lib/shortPublication";
import { dailyShortRecoveryDecision } from "../../src/lib/dailyShortRecovery";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || undefined;
const EXPECTED_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID ?? "";
const ARTIFACT_ROOT = process.env.AMM_SHORT_ARTIFACT_ROOT ??
  path.resolve("tools/shorts/daily-artifacts");
const RENDER_ROOT = process.env.AMM_SHORT_OUTPUT_ROOT ??
  path.join(ARTIFACT_ROOT, "renders");
const DAILY_RUN_COLLECTION = "daily_short_runs";
const PUBLICATION_COLLECTION = "short_publications";
const RUN_SCHEMA = "amm-daily-short-run-v2";
const PROCESSING_LEASE_MS = 6 * 60 * 60_000;
const db = new Firestore({ projectId: PROJECT_ID });
let currentTargetDate = "unknown";
type PipelineFormat = "weekday" | "weekend-recap";

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function after(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function etDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function publicationId(artifactKey: string): string {
  return createHash("sha256").update(artifactKey).digest("hex").slice(0, 48);
}

function runId(publicationDate: string, format: PipelineFormat): string {
  return format === "weekday" ? publicationDate : `${publicationDate}-weekend-recap`;
}

function publicationArtifactKey(
  dossier: Dossier,
  publicationDate: string,
  format: PipelineFormat,
): string {
  const source = dailyShortArtifactKey(dossier);
  return format === "weekday" ? source : `weekend-recap:${publicationDate}:${source}`;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
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

async function activeShortTickers(): Promise<string[]> {
  const tickers = await listActiveCompanyTickers();
  // Company-fleet admission already enforces supported US equities. Shorts
  // selection is read-only and must evaluate every currently active ticker,
  // not a manually maintained celebrity subset.
  return tickers.sort((left, right) => left.localeCompare(right));
}

interface FleetState {
  dossiers: Dossier[];
  pending: string[];
  rejected: string[];
  failed: string[];
  readiness?: "qualified-pair" | "fleet-complete" | "deadline";
}

async function fleetState(tickers: string[], targetDate: string): Promise<FleetState> {
  const states = await Promise.all(tickers.map(async (ticker) => {
    const [receipt, dossier, rejected, terminal] = await Promise.all([
      getDailyThesisCheck(ticker, targetDate).catch(() => null),
      getCachedDossier(ticker).catch(() => null),
      getRejectedDossierFactualUpdate(ticker, targetDate).catch(() => null),
      getDossierTerminalFailure(ticker, targetDate).catch(() => null),
    ]);
    if (
      receipt?.source === "dossier" &&
      receipt.outcome === "published" &&
      dossier?.date === targetDate &&
      receipt.sourceGeneratedAt === dossier.generatedAt &&
      dossierReleaseValidationError(dossier) === null
    ) {
      return { ticker, dossier, status: "ready" as const };
    }
    if (
      receipt?.source === "rejected-update" &&
      receipt.outcome === "no-directional-read" &&
      rejected &&
      receipt.sourceGeneratedAt === rejected.generatedAt
    ) {
      return { ticker, dossier: null, status: "rejected" as const };
    }
    if (terminal) return { ticker, dossier: null, status: "failed" as const };
    return { ticker, dossier: null, status: "pending" as const };
  }));
  return {
    dossiers: states.flatMap((state) => state.dossier ? [state.dossier] : []),
    pending: states.filter((state) => state.status === "pending").map((state) => state.ticker),
    rejected: states.filter((state) => state.status === "rejected").map((state) => state.ticker),
    failed: states.filter((state) => state.status === "failed").map((state) => state.ticker),
  };
}

async function readinessDeadlineAt(id: string, targetDate: string): Promise<number> {
  const waitMinutes = Math.max(0, Number(process.env.AMM_SHORT_FLEET_WAIT_MINUTES ?? "90"));
  const proposedDeadline = Date.now() + waitMinutes * 60_000;
  const ref = db.collection(DAILY_RUN_COLLECTION).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data() as {
      schema?: string;
      date?: string;
      readinessDeadlineAt?: number;
    } | undefined;
    if (stored?.schema && stored.schema !== RUN_SCHEMA) {
      throw new Error(`unsupported stored daily Shorts run for ${id}`);
    }
    if (stored?.date && stored.date !== targetDate) {
      throw new Error(`stored daily Shorts run ${id} targets ${stored.date}, not ${targetDate}`);
    }
    if (Number.isFinite(stored?.readinessDeadlineAt)) {
      return Number(stored!.readinessDeadlineAt);
    }
    transaction.set(ref, {
      schema: RUN_SCHEMA,
      date: targetDate,
      readinessStartedAt: Date.now(),
      readinessDeadlineAt: proposedDeadline,
    }, { merge: true });
    return proposedDeadline;
  });
}

async function waitForFleet(
  tickers: string[],
  targetDate: string,
  audience: Awaited<ReturnType<typeof dailyShortAudienceContext>>,
  deadline: number,
): Promise<FleetState> {
  for (;;) {
    const state = await fleetState(tickers, targetDate);
    const alreadyPublished = await publishedKeys(state.dossiers);
    const proposed = selectDailyShorts({
      dossiers: state.dossiers,
      date: targetDate,
      alreadyPublishedArtifactKeys: alreadyPublished,
      audienceSignals: audience.audienceSignals,
      publicationHistory: audience.publicationHistory,
    });
    const readiness = evaluateDailyShortReadiness({
      selection: proposed,
      pendingTickers: [...state.pending, ...state.failed],
      deadlineReached: Date.now() >= deadline,
    });
    if (readiness.shouldFinishWaiting) {
      if (readiness.reason === "waiting") {
        throw new Error("invalid daily Shorts readiness decision");
      }
      if (readiness.reason === "deadline") {
        // Polling ends so failure alerting can run, but the fleet gate below
        // still forbids publication until every active ticker has a receipt.
        const unfinished = [...state.pending, ...state.failed];
        console.error(
          `[shorts] dossier fleet remained incomplete ${targetDate}: ${unfinished.join(", ")}`,
        );
      }
      return { ...state, readiness: readiness.reason };
    }
    console.log(
      `[shorts] waiting for the complete followed-stock fleet; ` +
      `${proposed.selected.length}/${DAILY_SHORT_REQUIRED_COUNT} public candidates, ` +
      `unfinished: ${[...state.pending, ...state.failed].join(", ")}`,
    );
    await sleep(60_000);
  }
}

function selectionFailureDetail(
  selection: DailyShortSelection,
  state: FleetState,
): string {
  const error = dailyShortSelectionValidationError(selection) ??
    "daily Shorts selection failed";
  const pending = state.pending.length ? state.pending.join(", ") : "none";
  const withheld = selection.assessments
    .filter((assessment) => !assessment.eligible)
    .map((assessment) => `${assessment.ticker} (${assessment.reasons.join("; ")})`)
    .join(" | ") || "none";
  return (
    `${error}. Ready dossiers: ${state.dossiers.length}. ` +
    `Pending: ${pending}. Withheld: ${withheld}`
  );
}

async function publishedKeys(dossiers: Dossier[]): Promise<Set<string>> {
  if (!dossiers.length) return new Set();
  const refs = dossiers.map((dossier) =>
    db.collection(PUBLICATION_COLLECTION).doc(publicationId(dailyShortArtifactKey(dossier))));
  const snapshots = await db.getAll(...refs);
  return new Set(
    snapshots.flatMap((snapshot) => {
      const data = snapshot.data() as { artifactKey?: string; status?: string } | undefined;
      return data?.artifactKey && ["scheduled", "published"].includes(data.status ?? "")
        ? [data.artifactKey]
        : [];
    }),
  );
}

async function immutableSelection(
  proposed: DailyShortSelection,
  id: string,
): Promise<DailyShortSelection> {
  const ref = db.collection(DAILY_RUN_COLLECTION).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data() as {
      schema?: string;
      selection?: DailyShortSelection;
    } | undefined;
    if (stored?.selection) {
      if (stored.schema !== RUN_SCHEMA || stored.selection?.schema !== proposed.schema) {
        throw new Error(`unsupported stored daily Shorts run for ${id}`);
      }
      return stored.selection;
    }
    if (stored?.schema && stored.schema !== RUN_SCHEMA) {
      throw new Error(`unsupported stored daily Shorts run for ${id}`);
    }
    const validationError = dailyShortSelectionValidationError(proposed);
    if (validationError) throw new Error(validationError);
    // Failure alerting can create the run document before selection. Merge the
    // immutable pair into that operational receipt instead of treating an
    // alert-only document as an incompatible completed run.
    transaction.set(ref, {
      schema: RUN_SCHEMA,
      date: proposed.date,
      status: "selected",
      createdAt: Date.now(),
      selection: proposed,
    }, { merge: true });
    return proposed;
  });
}

async function existingImmutableSelection(id: string): Promise<DailyShortSelection | null> {
  const snapshot = await db.collection(DAILY_RUN_COLLECTION).doc(id).get();
  const stored = snapshot.data() as {
    schema?: string;
    selection?: DailyShortSelection;
  } | undefined;
  if (!stored?.selection) {
    if (stored?.schema && stored.schema !== RUN_SCHEMA) {
      throw new Error(`unsupported stored daily Shorts run for ${id}`);
    }
    return null;
  }
  if (stored.schema !== RUN_SCHEMA || stored.selection.schema !== "amm-daily-short-selection-v3") {
    throw new Error(`unsupported stored daily Shorts run for ${id}`);
  }
  const validationError = dailyShortSelectionValidationError(stored.selection);
  if (validationError) {
    throw new Error(`stored daily Shorts run for ${id} is invalid: ${validationError}`);
  }
  return stored.selection;
}

async function recoveryDisposition(id: string): Promise<{
  action: "skip" | "run";
  reason: string;
}> {
  const runRef = db.collection(DAILY_RUN_COLLECTION).doc(id);
  const runSnapshot = await runRef.get();
  const stored = runSnapshot.data() as {
    schema?: string;
    status?: string;
    results?: Array<{ ticker?: string; videoId?: string; publishAt?: string }>;
    readinessDeadlineAt?: number;
    createdAt?: number;
    selection?: DailyShortSelection;
  } | undefined;
  if (stored?.schema && stored.schema !== RUN_SCHEMA) {
    throw new Error(`unsupported stored daily Shorts run for ${id}`);
  }

  const selected = stored?.selection?.selected ?? [];
  const publicationSnapshots = selected.length
    ? await db.getAll(...selected.map((item) =>
        db.collection(PUBLICATION_COLLECTION).doc(publicationId(item.artifactKey))))
    : [];
  const publications = publicationSnapshots.map((snapshot) =>
    snapshot.data() as ShortPublicationRecord);
  const decision = dailyShortRecoveryDecision({
    runStatus: stored?.status,
    resultCount: stored?.results?.length ?? 0,
    selectedCount: selected.length,
    selectionCreatedAt: stored?.createdAt,
    readinessDeadlineAt: stored?.readinessDeadlineAt,
    publications,
    requiredCount: DAILY_SHORT_REQUIRED_COUNT,
  });

  if (decision.reason === "publication-pair-complete") {
    const results = publications
      .filter((record) => ["scheduled", "published"].includes(String(record?.status ?? "")))
      .map((record) => ({
        ticker: String(record?.ticker ?? ""),
        videoId: String(record?.videoId ?? "") || undefined,
        publishAt: String(record?.publishAt ?? "") || undefined,
      }))
      .slice(0, DAILY_SHORT_REQUIRED_COUNT);
    await runRef.set({
      status: "scheduled",
      completedAt: Date.now(),
      results,
      errors: [],
      recoveryReconciledAt: Date.now(),
    }, { merge: true });
  }
  return decision;
}

async function claimPublication(
  dossier: Dossier,
  publicationDate = dossier.date,
  format: PipelineFormat = "weekday",
): Promise<{
  claimed: boolean;
  id: string;
  previous?: Record<string, unknown>;
}> {
  const artifactKey = publicationArtifactKey(dossier, publicationDate, format);
  const id = publicationId(artifactKey);
  const ref = db.collection(PUBLICATION_COLLECTION).doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.data() as Record<string, unknown> | undefined;
    if (shortPublicationIsHandled(previous)) return { claimed: false, id, previous };
    transaction.set(ref, {
      schema: "amm-short-publication-v1",
      artifactKey,
      ticker: dossier.ticker,
      dossierDate: dossier.date,
      publicationDate,
      format,
      dossierGeneratedAt: dossier.generatedAt,
      // Freeze the public card copy with the exact dossier that cleared every
      // publication gate. Historical cards must not degrade when validators
      // evolve or a same-day dossier pointer advances.
      thesisTitle: dossier.emailHook.subjectPunchline,
      signalDirection: dossier.emailHook.signal.direction,
      signalStrength: dossier.emailHook.signal.strength,
      horizonSessions: dossier.emailHook.signal.horizonSessions,
      thesisLifecycleId: dossier.thesisLifecycle?.id ?? null,
      thesisOpenedDate: dossier.thesisLifecycle?.openedDate ?? dossier.date,
      thesisObservationIndex: dossier.thesisLifecycle?.observationIndex ?? 1,
      thesisObservationStatus: dossier.thesisLifecycle?.observationStatus ?? "opened",
      activeThesis:
        dossier.thesisLifecycle?.canonicalSubjectPunchline ?? dossier.emailHook.subjectPunchline,
      status: "processing",
      claimedAt: Date.now(),
      leaseExpiresAt: Date.now() + PROCESSING_LEASE_MS,
      attempts: Number(previous?.attempts ?? 0) + 1,
    }, { merge: true });
    return { claimed: true, id, previous };
  });
}

async function existingPublication(
  dossier: Dossier,
  publicationDate: string,
  format: PipelineFormat,
): Promise<{ id: string; previous: ShortPublicationRecord } | null> {
  const artifactKey = publicationArtifactKey(dossier, publicationDate, format);
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

async function sendFailureAlert(error: unknown): Promise<void> {
  const key = process.env.RESEND_API_KEY ?? "";
  if (!key) {
    console.error("[shorts] RESEND_API_KEY is unavailable; failure email was not sent");
    return;
  }
  const message = String(error).slice(0, 4_000);
  const phase = has("--recovery") ? "recovery" : "primary";
  const fingerprint = createHash("sha256")
    .update(`${currentTargetDate}:${phase}:${message}`)
    .digest("hex");
  const ref = db.collection(DAILY_RUN_COLLECTION).doc(currentTargetDate);
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
      subject: `AMM daily Shorts ${phase} failed · ${currentTargetDate}`,
      text:
        `The daily top-two Shorts ${phase} pass failed for dossier date ` +
        `${currentTargetDate}.\n\n${message}\n\n` +
        (phase === "primary"
          ? "The idempotent 7:00 AM ET recovery pass will check again before release. "
          : "The recovery pass also stopped without a complete evidence-cleared pair. ") +
        "No weak, stale or unverified video was published.",
    }),
  });
  if (!response.ok) {
    console.error(`[shorts] failure email rejected: ${response.status}`);
  }
}

async function prepareEpisode(
  dossier: Dossier,
  publicationDate = dossier.date,
  format: PipelineFormat = "weekday",
): Promise<{
  episode: ShortEpisodePackage;
  finalVideo: string;
  packageDir: string;
}> {
  const effectivePublicationDate = publicationDate;
  const suffix = format === "weekday" ? "" : `-weekend-recap-${effectivePublicationDate}`;
  const packageDir = format === "weekday"
    ? path.join(ARTIFACT_ROOT, "packages", dossier.date, dossier.ticker)
    : path.join(
        ARTIFACT_ROOT,
        "packages",
        "weekend-recap",
        effectivePublicationDate,
        dossier.ticker,
      );
  const packagePath = path.join(packageDir, "episode-package.json");
  const dossierPath = path.join(packageDir, "dossier.json");
  const renderDir = path.join(RENDER_ROOT, `${dossier.ticker}-${dossier.date}${suffix}`);
  const finalVideo = path.join(
    RENDER_ROOT,
    `${dossier.ticker}-${dossier.date}${suffix}-FINISHED.mp4`,
  );
  const qcPath = path.join(renderDir, "qc-receipt.json");
  await mkdir(packageDir, { recursive: true });
  await mkdir(RENDER_ROOT, { recursive: true });

  if (await exists(packagePath)) {
    const [episode, savedDossier] = await Promise.all([
      readFile(packagePath, "utf8").then((value) => JSON.parse(value) as ShortEpisodePackage),
      readFile(dossierPath, "utf8").then((value) => JSON.parse(value) as Dossier),
    ]);
    const persistedPackageIsCurrent = !(
      dailyShortArtifactKey(savedDossier) !== dailyShortArtifactKey(dossier) ||
      shortPackageValidationError(dossier, episode)
    );
    if (!persistedPackageIsCurrent) {
      // Template/package contracts are versioned by deterministic validation.
      // A cached render from an older public format is regenerated from the
      // exact selected dossier rather than published with stale semantics.
      await writeFile(dossierPath, `${JSON.stringify(dossier, null, 2)}\n`);
      await run(
        "tools/shorts/make-daily-short.sh",
        [
          "--dossier", dossierPath,
          "--out", packageDir,
          "--format", format,
          ...(format === "weekend-recap"
            ? ["--publication-date", effectivePublicationDate]
            : []),
          "--force-new-render",
        ],
        { ...process.env, AMM_SHORT_OUTPUT_ROOT: RENDER_ROOT },
      );
    } else if (!(await exists(finalVideo)) || !(await exists(qcPath))) {
      await run("tools/shorts/make-episode.sh", [packagePath], {
        ...process.env,
        AMM_SHORT_OUTPUT_ROOT: RENDER_ROOT,
      });
    }
  } else {
    await writeFile(dossierPath, `${JSON.stringify(dossier, null, 2)}\n`);
    await run(
      "tools/shorts/make-daily-short.sh",
      [
        "--dossier", dossierPath,
        "--out", packageDir,
        "--format", format,
        ...(format === "weekend-recap"
          ? ["--publication-date", effectivePublicationDate]
          : []),
        "--render",
      ],
      { ...process.env, AMM_SHORT_OUTPUT_ROOT: RENDER_ROOT },
    );
  }

  const [episode, qc] = await Promise.all([
    readFile(packagePath, "utf8").then((value) => JSON.parse(value) as ShortEpisodePackage),
    readFile(qcPath, "utf8").then((value) => JSON.parse(value) as {
      status?: string;
      videoSha256?: string;
    }),
  ]);
  const packageError = shortPackageValidationError(dossier, episode);
  if (packageError) throw new Error(`episode package failed final binding: ${packageError}`);
  if (qc.status !== "pass" || !/^[a-f0-9]{64}$/.test(qc.videoSha256 ?? "")) {
    throw new Error(`final ${dossier.ticker} media has no passing QC receipt`);
  }
  if (!(await exists(finalVideo))) throw new Error(`final ${dossier.ticker} video is missing`);
  return { episode, finalVideo, packageDir };
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

function optionalOauthCredentials(): ReturnType<typeof oauthCredentials> | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID ?? "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? "";
  return clientId && clientSecret && refreshToken
    ? { clientId, clientSecret, refreshToken }
    : null;
}

async function dailyShortAudienceContext(targetDate: string): Promise<
  ReturnType<typeof buildDailyShortAudienceContext>
> {
  try {
    const snapshot = await db.collection(PUBLICATION_COLLECTION).limit(500).get();
    const records = snapshot.docs.map((document) => ({
      id: document.id,
      ...(document.data() as StoredShortAudienceRecord),
    }));
    const credentials = optionalOauthCredentials();
    const refreshable = records
      .filter((record) =>
        Boolean(record.videoId) &&
        (record.status === "scheduled" || record.status === "published"))
      .sort((left, right) =>
        Number(right.scheduledAt ?? 0) - Number(left.scheduledAt ?? 0))
      .slice(0, 50);
    if (credentials && refreshable.length) {
      try {
        const metrics = await fetchYouTubeShortAudienceMetrics({
          credentials,
          videoIds: refreshable.map((record) => record.videoId!),
          endDate: targetDate,
        });
        if (metrics.size) {
          const batch = db.batch();
          for (const record of refreshable) {
            const refreshed = metrics.get(record.videoId!);
            if (!refreshed || !record.id) continue;
            record.youtubeMetrics = refreshed;
            batch.set(
              db.collection(PUBLICATION_COLLECTION).doc(record.id),
              { youtubeMetrics: refreshed, audienceMetricsUpdatedAt: Date.now() },
              { merge: true },
            );
          }
          await batch.commit();
        }
      } catch (error) {
        // Analytics is a ranking enhancement, never a publication dependency.
        // Preserve the last audited metrics instead of silencing the edition.
        console.warn(`[shorts] audience metric refresh skipped: ${String(error).slice(0, 500)}`);
      }
    }
    return buildDailyShortAudienceContext(records, targetDate);
  } catch (error) {
    console.warn(`[shorts] audience history unavailable; using cold-start priors: ${String(error)}`);
    return buildDailyShortAudienceContext([], targetDate);
  }
}

async function main(): Promise<void> {
  const publishImmediately = has("--publish-now");
  const publish = has("--publish") || publishImmediately;
  const render = publish || has("--render");
  const selectOnly = !render;
  const today = etDate();
  if (!isUsEquityTradingDay(today)) {
    const args = ["tsx", "tools/shorts/run-weekly-pipeline.ts"];
    const explicitTargetDate = after("--target-date");
    if (explicitTargetDate) args.push("--target-date", explicitTargetDate);
    if (render) args.push("--render");
    if (publish) args.push("--publish");
    await run("npx", args, process.env);
    return;
  }
  const tradingDay = isUsEquityTradingDay(today);
  const format: PipelineFormat = tradingDay ? "weekday" : "weekend-recap";
  const targetDate = after("--target-date") ??
    (tradingDay ? today : previousUsEquityTradingDay(today));
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(targetDate)) throw new Error("invalid --target-date");
  const currentRunId = runId(today, format);
  currentTargetDate = currentRunId;
  if (publish && format === "weekday" && targetDate !== today) {
    throw new Error(
      `publishing stale research is forbidden: target ${targetDate}, publication date ${today}`,
    );
  }
  const recovery = has("--recovery");
  if (recovery) {
    const disposition = await recoveryDisposition(currentRunId);
    if (disposition.action === "skip") {
      console.log(`[shorts] recovery no-op: ${disposition.reason}`);
      return;
    }
    console.log(`[shorts] recovery proceeding: ${disposition.reason}`);
  }

  const frozenSelection = selectOnly
    ? null
    : await existingImmutableSelection(currentRunId);
  if (frozenSelection && frozenSelection.date !== targetDate) {
    throw new Error(
      `stored daily Shorts run ${currentRunId} targets ${frozenSelection.date}, not ${targetDate}`,
    );
  }
  const activeTickers = await activeShortTickers();
  const tickers = [...new Set([
    ...activeTickers,
    ...(frozenSelection?.selected.map((item) => item.ticker) ?? []),
  ])].sort();
  const audience = await dailyShortAudienceContext(targetDate);
  const deadline = selectOnly || frozenSelection
    ? Date.now()
    : recovery
      // Recovery checks the dossier state that exists at 07:00 ET. It must
      // leave enough time to render, verify and schedule both 08:30/08:45
      // releases instead of opening another 90-minute readiness window.
      ? Date.now()
      : await readinessDeadlineAt(currentRunId, targetDate);
  const state = selectOnly
    ? await fleetState(tickers, targetDate)
    : frozenSelection
      // A retry resumes the immutable pair, but it still re-proves that every
      // followed stock completed the underlying daily product before shipping.
      ? await fleetState(tickers, targetDate)
      : await waitForFleet(tickers, targetDate, audience, deadline);
  const alreadyPublished = format === "weekday"
    ? await publishedKeys(state.dossiers)
    : new Set<string>();
  const proposed = selectDailyShorts({
    dossiers: state.dossiers,
    date: targetDate,
    alreadyPublishedArtifactKeys: alreadyPublished,
    audienceSignals: audience.audienceSignals,
    publicationHistory: audience.publicationHistory,
  });
  const weekendIndex = Math.max(
    0,
    Math.round(
      (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${targetDate}T12:00:00Z`)) /
      86_400_000,
    ) - 1,
  );
  const formattedProposed: DailyShortSelection = format === "weekday"
    ? proposed
    : {
        ...proposed,
        selected: proposed.selected.length
          ? [proposed.selected[weekendIndex % proposed.selected.length]!]
          : [],
      };
  const selection = selectOnly
    ? formattedProposed
    : frozenSelection ?? (
        dailyShortSelectionValidationError(formattedProposed)
          ? (() => {
              throw new Error(selectionFailureDetail(formattedProposed, state));
            })()
          : await immutableSelection(formattedProposed, currentRunId)
      );
  const fleetGate = evaluateDailyShortFleetGate({
    selection,
    pendingTickers: [...state.pending, ...state.failed],
  });
  if (!selectOnly && !fleetGate.mayProceed) {
    throw new Error(fleetGate.error ?? "daily Shorts fleet gate failed");
  }
  if (!selectOnly) {
    const fleetAudit = {
      status: fleetGate.partialFleet ? "incomplete" : "complete",
      checkedAt: Date.now(),
      readyDossierCount: state.dossiers.length,
      selectedCount: selection.selected.length,
      pending: fleetGate.excludedPendingTickers,
      rejected: state.rejected,
      terminalFailures: state.failed,
    };
    await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
      lastFleetCheck: fleetAudit,
      ...(!frozenSelection ? { fleetAtSelection: fleetAudit } : {}),
    }, { merge: true });
  }
  console.log(JSON.stringify({
    targetDate,
    publicationDate: today,
    format,
    mode: publish ? "publish" : render ? "render" : "select-only",
    activeFleetTickers: tickers,
    rejected: state.rejected,
    terminalFailures: state.failed,
    pending: state.pending,
    resumedImmutablePair: Boolean(frozenSelection),
    selected: selection.selected.map((item) => ({
      ticker: item.ticker,
      votes: item.votes,
      editorialStrength: item.editorialStrength,
      selectionRole: item.selectionRole,
      ranking: item.ranking,
      artifactKey: item.artifactKey,
    })),
    withheld: selection.assessments
      .filter((item) => !item.eligible)
      .map((item) => ({ ticker: item.ticker, reasons: item.reasons })),
  }, null, 2));
  if (selectOnly) return;

  const pairError = dailyShortSelectionValidationError(selection);
  if (pairError) throw new Error(pairError);

  const dossiers = new Map(state.dossiers.map((dossier) => [
    dailyShortArtifactKey(dossier),
    dossier,
  ]));
  const errors: string[] = [];
  const results: Array<{ ticker: string; videoId?: string; publishAt?: string }> = [];
  const slots = publishImmediately
    ? Array.from(
        { length: DAILY_SHORT_REQUIRED_COUNT },
        (_, index) => new Date(Date.now() + index * 1_000),
      )
    : publish
      ? publicationSlots({
      publicationDate: today,
      count: DAILY_SHORT_REQUIRED_COUNT,
      })
      : plannedPublicationSlots({
        publicationDate: today,
        count: DAILY_SHORT_REQUIRED_COUNT,
      });
  const pending: Array<{
    selected: (typeof selection.selected)[number];
    dossier: Dossier;
    slot: Date;
  }> = [];
  for (const [index, selected] of selection.selected.entries()) {
    const dossier = dossiers.get(selected.artifactKey);
    if (!dossier) {
      errors.push(`${selected.ticker}: immutable selected dossier is no longer available`);
      continue;
    }
    const existing = await existingPublication(dossier, today, format);
    if (existing) {
      const status = String(existing.previous?.status ?? "");
      if (status === "scheduled" || status === "published") {
        results.push({
          ticker: selected.ticker,
          videoId: String(existing.previous?.videoId ?? "") || undefined,
          publishAt: String(existing.previous?.publishAt ?? "") || undefined,
        });
      } else {
        errors.push(`${selected.ticker}: another execution still holds the publication lease`);
      }
      continue;
    }
    pending.push({ selected, dossier, slot: slots[index]! });
  }
  if (errors.length) {
    await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
      status: "failed",
      completedAt: Date.now(),
      results,
      errors,
    }, { merge: true });
    throw new Error(`daily Shorts pair preflight failed:\n${errors.join("\n")}`);
  }
  if (!pending.length) {
    if (results.length !== DAILY_SHORT_REQUIRED_COUNT) {
      throw new Error(
        `daily Shorts pair receipt is incomplete: ${results.length}/${DAILY_SHORT_REQUIRED_COUNT}`,
      );
    }
    await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
      status: "scheduled",
      completedAt: Date.now(),
      results,
      errors: [],
    }, { merge: true });
    return;
  }

  const claimed: Array<{
    selected: (typeof selection.selected)[number];
    dossier: Dossier;
    slot: Date;
    claimId: string;
  }> = [];
  for (const { selected, dossier, slot } of pending) {
    const claim = await claimPublication(dossier, today, format);
    if (!claim.claimed) {
      const status = String(claim.previous?.status ?? "");
      if (status === "scheduled" || status === "published") {
        results.push({
          ticker: selected.ticker,
          videoId: String(claim.previous?.videoId ?? "") || undefined,
          publishAt: String(claim.previous?.publishAt ?? "") || undefined,
        });
      } else {
        errors.push(`${selected.ticker}: publication claim is held by another execution`);
      }
      continue;
    }
    claimed.push({ selected, dossier, slot, claimId: claim.id });
  }
  if (errors.length) {
    await Promise.all(claimed.map(({ claimId }) =>
      updatePublication(claimId, {
        status: "failed",
        error: errors.join("\n").slice(0, 2_000),
        failedAt: Date.now(),
        leaseExpiresAt: null,
      }).catch(() => {})));
  } else {
    const preparedPair: Array<{
      selected: (typeof selection.selected)[number];
      dossier: Dossier;
      slot: Date;
      claimId: string;
      prepared: Awaited<ReturnType<typeof prepareEpisode>>;
    }> = [];
    for (const item of claimed) {
      try {
        const prepared = await prepareEpisode(item.dossier, today, format);
        preparedPair.push({ ...item, prepared });
      } catch (error) {
        errors.push(`${item.selected.ticker}: ${String(error).slice(0, 2_000)}`);
        // Prepare every claimed member even when its sibling fails. The pair
        // gate below still prevents a partial edition from publishing, while
        // the successful render remains reusable by the recovery run.
        continue;
      }
    }

    // Both members of a new pair cross deterministic package and media QC
    // before either is uploaded. A successful first render can be reused on a
    // retry, but it can never cause a one-video edition by itself.
    if (errors.length || preparedPair.length !== claimed.length) {
      const message = errors.join("\n") ||
        `prepared only ${preparedPair.length}/${claimed.length} claimed videos`;
      await Promise.all(claimed.map(({ claimId }) =>
        updatePublication(claimId, {
          status: "failed",
          error: message.slice(0, 2_000),
          failedAt: Date.now(),
          leaseExpiresAt: null,
        }).catch(() => {})));
    } else {
      for (const item of preparedPair) {
        await updatePublication(item.claimId, {
          status: publish ? "processing" : "rendered",
          episodeId: item.prepared.episode.episodeId,
          sourceBundleSha256: item.prepared.episode.provenance.sourceBundleSha256,
          sourceCitationIds: shortEpisodeUsedCitationIds(item.prepared.episode),
          sourceCitations: shortEpisodeUsedCitations(item.prepared.episode),
          packageDir: item.prepared.packageDir,
          finalVideo: item.prepared.finalVideo,
          publishAt: item.slot.toISOString(),
          leaseExpiresAt: publish ? Date.now() + PROCESSING_LEASE_MS : null,
        });
      }

      if (!publish) {
        results.push(...preparedPair.map((item) => ({
          ticker: item.selected.ticker,
          publishAt: item.slot.toISOString(),
        })));
      } else {
        for (const item of preparedPair) {
          try {
            const video = await publishYouTubeShort({
              credentials: oauthCredentials(),
              episode: item.prepared.episode,
              videoPath: item.prepared.finalVideo,
              publishAt: item.slot,
              publishImmediately,
              expectedChannelId: EXPECTED_CHANNEL_ID,
              onUploadSession: async (uploadSessionUrl) => {
                await updatePublication(item.claimId, {
                  status: "processing",
                  // Resumable URL is operationally sensitive and remains server-side.
                  uploadSessionUrl,
                  leaseExpiresAt: Date.now() + PROCESSING_LEASE_MS,
                });
              },
            });
            await updatePublication(item.claimId, {
              status: video.status?.privacyStatus === "public" ? "published" : "scheduled",
              videoId: video.id,
              publishAt: video.status?.publishAt ?? item.slot.toISOString(),
              youtubePrivacyStatus: video.status?.privacyStatus ?? "private",
              uploadSessionUrl: null,
              leaseExpiresAt: null,
              scheduledAt: Date.now(),
            });
            results.push({
              ticker: item.selected.ticker,
              videoId: video.id,
              publishAt: video.status?.publishAt ?? item.slot.toISOString(),
            });
          } catch (error) {
            const message = String(error).slice(0, 2_000);
            errors.push(`${item.selected.ticker}: ${message}`);
            await updatePublication(item.claimId, {
              status: "failed",
              error: message,
              failedAt: Date.now(),
              leaseExpiresAt: null,
            }).catch(() => {});
            break;
          }
        }
      }
    }
  }

  if (!errors.length && results.length !== DAILY_SHORT_REQUIRED_COUNT) {
    errors.push(
      `daily Shorts pair receipt is incomplete: ${results.length}/${DAILY_SHORT_REQUIRED_COUNT}`,
    );
  }
  /*
   * Any upload failure keeps the run non-terminal. Scheduler and Cloud Run
   * retries reuse rendered/QC-passed media and the deterministic publication
   * IDs; an already scheduled member is detected while the missing member is
   * recovered.
   */
  if (errors.length) {
    for (const { claimId } of claimed) {
      const snapshot = await db.collection(PUBLICATION_COLLECTION).doc(claimId).get();
      const status = String(snapshot.data()?.status ?? "");
      if (status === "rendered" || status === "processing" || status === "uploading") {
        await updatePublication(claimId, {
          status: "failed",
          error: errors.join("\n").slice(0, 2_000),
          failedAt: Date.now(),
          leaseExpiresAt: null,
        }).catch(() => {});
      }
    }
  }
  await db.collection(DAILY_RUN_COLLECTION).doc(currentRunId).set({
    status: errors.length ? "failed" : publish ? "scheduled" : "rendered",
    completedAt: Date.now(),
    results,
    errors,
  }, { merge: true });
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (errors.length) throw new Error(`daily Shorts pipeline failed:\n${errors.join("\n")}`);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await sendFailureAlert(error);
  } catch (alertError) {
    console.error(`[shorts] failure alert crashed: ${String(alertError)}`);
  }
  process.exitCode = 1;
});
