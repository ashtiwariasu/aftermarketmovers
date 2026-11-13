import { randomUUID } from "node:crypto";
import { listActiveCompanyTickers } from "./companyFleet";
import { getProfile } from "./companyStore";
import { assessRelevance, rawPayloadHash } from "./newsNormalize";
import { collectAllProviders } from "./newsProviders";
import {
  acquirePipelineLease,
  claimPendingDeadLetters,
  createNewsRun,
  releasePipelineLease,
  rescheduleDeadLetter,
  resolveCollectionDeadLetters,
  resolveDeadLetter,
  renewPipelineLease,
  saveCandidateDecision,
  saveDeadLetter,
  saveNewsCheckpoint,
  updateNewsRun,
  updateSourceHealth,
  upsertAcceptedArticle,
} from "./newsStore";
import { NEWS_PIPELINE_VERSION, type NewsRunRecord, type ProviderResult } from "./newsTypes";
import { partitionResearchSupportedTickers } from "./researchSupport";

const LEASE_ID = "scheduled-news";
const LEASE_TTL_MS = 55 * 60_000;

export interface RunNewsOptions {
  mode?: "scheduled" | "hourly" | "backfill";
  lookbackHours?: number;
  tickers?: string[];
  concurrency?: number;
}

export interface RunNewsResult {
  acquired: boolean;
  run: NewsRunRecord;
}

async function watchedTickers(): Promise<string[]> {
  return listActiveCompanyTickers();
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (cursor < values.length && shouldContinue()) {
      const index = cursor++;
      await work(values[index]);
    }
  });
  await Promise.all(workers);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureDeadLetter(
  run: NewsRunRecord,
  input: Parameters<typeof saveDeadLetter>[0],
): Promise<void> {
  try {
    await saveDeadLetter(input);
  } catch (error) {
    run.errors.push(`dead-letter-write/${input.ticker ?? "global"}/${input.stage}: ${errorMessage(error)}`);
  }
}

function aggregateProvider(
  accumulator: NewsRunRecord["providerResults"],
  result: ProviderResult,
): void {
  const existing = accumulator.find((item) => item.provider === result.provider);
  if (existing) {
    existing.fetched += result.candidates.length;
    existing.durationMs += result.durationMs;
    existing.active ||= result.active;
    existing.attempts++;
    if (result.error) existing.failures++;
    else existing.successes++;
    if (result.error) existing.error = existing.error
      ? `${existing.error}; ${result.error}`.slice(0, 500)
      : result.error;
    return;
  }
  accumulator.push({
    provider: result.provider,
    tier: result.tier,
    active: result.active,
    fetched: result.candidates.length,
    durationMs: result.durationMs,
    attempts: 1,
    successes: result.error ? 0 : 1,
    failures: result.error ? 1 : 0,
    ...(result.error ? { error: result.error } : {}),
  });
}

export async function runNewsPipeline(options: RunNewsOptions = {}): Promise<RunNewsResult> {
  const startedAt = Date.now();
  const mode = options.mode ?? "scheduled";
  const overlapHours = options.lookbackHours ?? (mode === "backfill" ? 48 : 13);
  const candidates = [...new Set((options.tickers ?? await watchedTickers()).map((ticker) => ticker.toUpperCase()))]
    .filter((ticker) => /^[A-Z.\-]{1,6}$/.test(ticker))
    .sort();
  const support = await partitionResearchSupportedTickers(candidates);
  const targets = support.supported;
  const runId = `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const run: NewsRunRecord = {
    id: runId,
    pipelineVersion: NEWS_PIPELINE_VERSION,
    mode,
    status: "running",
    startedAt,
    requestedTickers: targets,
    providerResults: [],
    candidates: 0,
    observations: 0,
    accepted: 0,
    rejected: 0,
    deduplicated: 0,
    persisted: 0,
    eventsUpdated: 0,
    recoveredDeadLetters: 0,
    failedDeadLetterReplays: 0,
    errors: [],
    warnings: support.excluded.map((item) =>
      `${item.symbol}/support: ${item.code} — ${item.message}`
    ),
  };
  const acquired = await acquirePipelineLease(LEASE_ID, runId, LEASE_TTL_MS);
  if (!acquired) {
    run.status = "failed";
    run.finishedAt = Date.now();
    run.errors.push("another scheduled news run holds the active lease");
    return { acquired: false, run };
  }
  try {
    await createNewsRun(run);
    // Replays use the normalized observation plus its original raw SHA-256;
    // no licensed article body needs to be retained in the dead-letter queue.
    const deadLetters = await claimPendingDeadLetters(runId, 25);
    for (const deadLetter of deadLetters) {
      try {
        const decision = { ...deadLetter.decision!, runId };
        await saveCandidateDecision(decision);
        run.observations++;
        if (decision.assessment.accepted) {
          const persisted = await upsertAcceptedArticle(decision);
          run.eventsUpdated++;
          if (persisted.created) run.persisted++;
          else run.deduplicated++;
        }
        await resolveDeadLetter(deadLetter.id, runId);
        run.recoveredDeadLetters++;
      } catch (error) {
        const message = errorMessage(error);
        try {
          await rescheduleDeadLetter(deadLetter.id, runId, message);
        } catch (rescheduleError) {
          run.errors.push(`dead-letter-reschedule/${deadLetter.id}: ${errorMessage(rescheduleError)}`);
        }
        run.failedDeadLetterReplays++;
        run.errors.push(`dead-letter/${deadLetter.id}: ${message}`);
      }
    }

    const sinceMs = startedAt - overlapHours * 3_600_000;
    let leaseHealthy = true;
    await mapConcurrent(targets, options.concurrency ?? 3, async (ticker) => {
      const attemptedAt = Date.now();
      try {
        const profile = await getProfile(ticker);
        const providerResults = await collectAllProviders(
          {
            ticker,
            ...(profile?.name ? { name: profile.name } : {}),
            ...(profile?.newsSources ? { newsSources: profile.newsSources } : {}),
          },
          sinceMs,
        );
        const providerCheckpoint: Record<string, {
          tier: ProviderResult["tier"];
          active: boolean;
          fetched: number;
          error?: string;
        }> = {};
        let newestPublishedAt = 0;
        const reliableCollectionSucceeded = providerResults.every(
          (result) => result.tier === "discovery" || !result.error,
        );

        for (const result of providerResults) {
          aggregateProvider(run.providerResults, result);
          providerCheckpoint[result.provider] = {
            tier: result.tier,
            active: result.active,
            fetched: result.candidates.length,
            ...(result.error ? { error: result.error } : {}),
          };
          if (result.active) {
            try {
              await updateSourceHealth({
                provider: result.provider,
                tier: result.tier,
                ticker,
                runId,
                attemptedAt,
                successful: !result.error,
                nonEmpty: result.candidates.length > 0,
                fetched: result.candidates.length,
                durationMs: result.durationMs,
                ...(result.error ? { error: result.error } : {}),
              });
            } catch (error) {
              run.errors.push(`${ticker}/${result.provider}/source-health-write: ${errorMessage(error)}`);
            }
          }
          if (result.error) {
            const message = `${ticker}/${result.provider}: ${result.error}`;
            if (result.tier === "discovery") run.warnings.push(message);
            else run.errors.push(message);
          }

          for (const candidate of result.candidates) {
            // Scheduled overlap is deliberate. SEC filings receive a longer grace
            // window because filing-date metadata does not include a time.
            const cutoff = candidate.provider === "sec" ? sinceMs - 48 * 3_600_000 : sinceMs;
            const candidateVersionAt = Math.max(candidate.publishedAt, candidate.updatedAt ?? 0);
            if (candidateVersionAt < cutoff) continue;
            newestPublishedAt = Math.max(newestPublishedAt, candidateVersionAt);
            run.candidates++;
            const assessment = assessRelevance(candidate, ticker, profile?.name, startedAt);
            const decision = { runId, ticker, companyName: profile?.name, candidate, assessment };
            try {
              await saveCandidateDecision(decision);
              run.observations++;
              if (!assessment.accepted) {
                run.rejected++;
                continue;
              }
              run.accepted++;
              const persisted = await upsertAcceptedArticle(decision);
              run.eventsUpdated++;
              if (persisted.created) run.persisted++;
              else run.deduplicated++;
            } catch (error) {
              const message = errorMessage(error);
              run.errors.push(`${ticker}/${candidate.provider}/persist: ${message}`);
              await captureDeadLetter(run, {
                runId,
                ticker,
                stage: "persist-candidate",
                error: message.slice(0, 500),
                payloadHash: candidate.rawSha256 ?? rawPayloadHash(candidate.raw),
                decision,
              });
            }
          }
        }
        try {
          await saveNewsCheckpoint({
            ticker,
            runId,
            attemptedAt,
            ...(reliableCollectionSucceeded ? { successfulAt: Date.now() } : {}),
            ...(newestPublishedAt ? { newestPublishedAt } : {}),
            providers: providerCheckpoint,
          });
        } catch (error) {
          const message = errorMessage(error);
          run.errors.push(`${ticker}/checkpoint-write: ${message}`);
          await captureDeadLetter(run, {
            runId,
            ticker,
            stage: "save-checkpoint",
            error: message.slice(0, 500),
          });
        }
        if (reliableCollectionSucceeded) {
          await resolveCollectionDeadLetters(ticker, runId).catch((error) => {
            run.errors.push(`${ticker}/dead-letter-resolution: ${errorMessage(error)}`);
          });
        }
        try {
          if (!await renewPipelineLease(LEASE_ID, runId, LEASE_TTL_MS)) {
            leaseHealthy = false;
            run.errors.push(`${ticker}: pipeline lease was lost`);
          }
        } catch (error) {
          leaseHealthy = false;
          run.errors.push(`${ticker}/lease-renewal: ${errorMessage(error)}`);
        }
      } catch (error) {
        const message = errorMessage(error);
        run.errors.push(`${ticker}: ${message}`);
        await captureDeadLetter(run, {
          runId,
          ticker,
          stage: "collect-ticker",
          error: message.slice(0, 500),
        });
        await saveNewsCheckpoint({
          ticker,
          runId,
          attemptedAt,
          providers: {},
        }).catch((checkpointError) => {
          run.errors.push(`${ticker}/failed-checkpoint-write: ${errorMessage(checkpointError)}`);
        });
      }
    }, () => leaseHealthy);
    if (!leaseHealthy) throw new Error("pipeline lease lost; stopped assigning new tickers");
    const providerAttempts = run.providerResults.reduce((total, result) => total + result.attempts, 0);
    const providerSuccesses = run.providerResults.reduce(
      (total, result) => total + (result.active ? result.successes : 0),
      0,
    );
    run.status = run.errors.length === 0
      ? "completed"
      : providerSuccesses > 0 || run.recoveredDeadLetters > 0
        ? "partial"
        : providerAttempts > 0 || run.failedDeadLetterReplays > 0
          ? "failed"
          : "partial";
  } catch (error) {
    run.status = "failed";
    run.errors.push(errorMessage(error));
  } finally {
    run.finishedAt = Date.now();
    await updateNewsRun(run).catch(() => {});
    await releasePipelineLease(LEASE_ID, runId).catch(() => {});
  }
  return { acquired: true, run };
}
