import type { DeskPriorityCard } from "@/components/DeskPriorityStack";
import type { Desk } from "@/lib/desk";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  getRejectedDossierFactualUpdate,
  type Dossier,
  type DossierEmailHook,
} from "@/lib/dossier";
import {
  getDossierHistory,
  getPeriodicFilingsSnapshot,
} from "@/lib/companyStore";
import { daysToEvent } from "@/lib/news";
import { getThesisMovementObservations } from "@/lib/scoreboard";
import {
  buildThesisMovementView,
  mergeThesisMovementObservations,
  nextObservationFromReview,
  signalFromThesisScore,
  signalScore,
  thesisMovementWindow,
  type ThesisMovementObservation,
} from "@/lib/thesisMovement";
import { getTickerSnapshot, type TickerSnapshot } from "@/lib/ticker";
import { getDailyThesisCheck } from "@/lib/dailyThesisCheck";

type Status = "flag" | "event" | "quiet";

function pct(value: number | null): string {
  if (value == null) return "—";
  if (Math.abs(value) < 0.005) return "0.00%";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function statusOf(snapshot: TickerSnapshot, eventDays: number | null): Status {
  const day = Math.abs(snapshot.dayChangePercent ?? 0);
  const afterHours = Math.abs(snapshot.afterHoursChangePercent ?? 0);
  if (afterHours >= 1.5 || day >= 2.5) return "flag";
  if (eventDays != null && eventDays >= 0 && eventDays <= 14) return "event";
  return "quiet";
}

function tapeLine(
  snapshot: TickerSnapshot,
  status: Status,
  eventDays: number | null,
): string {
  const day = pct(snapshot.dayChangePercent);
  const afterHours = snapshot.afterHoursChangePercent != null
    ? `${pct(snapshot.afterHoursChangePercent)} after hours`
    : "no after-hours move";
  if (status === "flag") return `${day} on the day and ${afterHours}.`;
  if (status === "event" && eventDays != null) {
    return `${day} on the day and ${afterHours}; ${
      eventDays === 0
        ? "the next company event is today"
        : `${eventDays} days remain to the next company event`
    }.`;
  }
  return `${day} on the day and ${afterHours}.`;
}

export function isoDateInNewYork(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function priority(card: DeskPriorityCard): number {
  const move = Math.max(
    Math.abs(card.dayChangePercent ?? 0),
    Math.abs(card.afterHoursChangePercent ?? 0),
  );
  return (
    (card.hasResearch ? 500 : 0) +
    card.votes.support * 60 +
    card.editorialScore * 2 +
    Math.min(move, 5) * 2
  );
}

function decisionThesis(ticker: string, hook: DossierEmailHook): string {
  const hasHorizon =
    /\b10\s*[–—-]\s*15\s+(?:trading\s+)?sessions?\b/i.test(hook.thesis);
  const hasDirection =
    /\b(?:support|lift|strengthen|pressure|weigh on|weaken|hurt)\b[^.!?]{0,45}\b(?:shares?|stock)\b/i.test(
      hook.thesis,
    );
  if (hasHorizon && hasDirection) return hook.thesis;
  const proposition = hook.subjectPunchline.replace(/[.!?]+$/, "");
  const direction = hook.signal.direction === "UP" ? "support" : "pressure";
  return `${proposition}. Five analysts conclude this change is more likely to ${direction} ${ticker} shares over the next 10–15 sessions.`;
}

function rejectedDecisionReason(
  update: NonNullable<
    Awaited<ReturnType<typeof getRejectedDossierFactualUpdate>>
  >,
): string {
  if (update.reason === "fatal-contradiction") {
    return "A core premise failed an arithmetic, period, or primary-source check, so AMM blocked the thesis regardless of the raw vote count.";
  }
  if (update.reason === "incomplete-ballot") {
    const available =
      update.votesSupport + update.votesOppose + update.votesUncertain;
    const unavailable = update.votesUnavailable ?? 5 - available;
    return `${available} analyst ballots passed validation; ${unavailable} was unavailable. AMM preserved the factual change without inventing the missing vote or publishing a directional thesis.`;
  }
  return `${update.votesSupport} of five analysts supported the exact proposition; it did not clear AMM's three-vote publication bar.`;
}

function dossierMovementObservation(
  dossier: Dossier,
): ThesisMovementObservation {
  const lifecycle = dossier.thesisLifecycle;
  const votes = dossier.emailHook.votes;
  return {
    schemaVersion: 1,
    date: dossier.date,
    observedAt: dossier.generatedAt,
    index: lifecycle?.observationIndex ?? 1,
    status: lifecycle?.observationStatus ?? "opened",
    score: signalScore(lifecycle?.latestSignal ?? dossier.emailHook.signal),
    support: votes.support,
    oppose: votes.oppose,
    uncertain: votes.uncertain,
    unavailable: Math.max(
      0,
      5 - votes.support - votes.oppose - votes.uncertain,
    ),
    ...(dossier.briefAuditId ? { auditId: dossier.briefAuditId } : {}),
  };
}

/**
 * Builds the single canonical Desk presentation model used by the web and
 * native clients. No client is allowed to infer a thesis from market data.
 */
export async function buildDeskPriorityCards(
  desk: Desk,
  renderedAt = new Date(),
  tickers: readonly string[] = desk.tickers,
): Promise<DeskPriorityCard[]> {
  const todayEt = isoDateInNewYork(renderedAt);
  const cards = (
    await Promise.all(
      tickers.map(
        async (ticker): Promise<DeskPriorityCard | null> => {
          const [snapshot, storedDossier, rejectedUpdate, dailyCheck] = await Promise.all([
            getTickerSnapshot(ticker),
            getCachedDossier(ticker).catch((error) => {
              console.error(
                `[desk-presentation] ${ticker}: cached dossier read failed`,
                error,
              );
              return null;
            }),
            getRejectedDossierFactualUpdate(ticker, todayEt).catch(() => null),
            getDailyThesisCheck(ticker, todayEt).catch(() => null),
          ]);
          if (!snapshot) return null;

          const eventDays = daysToEvent(snapshot.nextEvent);
          const status = statusOf(snapshot, eventDays);
          const currentDossier =
            dailyCheck?.source === "dossier" &&
            storedDossier?.date === todayEt &&
            dossierReleaseValidationError(storedDossier) === null
              ? storedDossier
              : null;
          const rejected =
            dailyCheck?.source === "rejected-update" ? rejectedUpdate : null;
          const latestAcceptedDossier =
            dossierReleaseValidationError(storedDossier) === null
              ? storedDossier
              : null;
          const dossier =
            currentDossier ??
            (!rejected ? latestAcceptedDossier : null);
          const acceptedDossier = dossier ?? latestAcceptedDossier;

          if (!dossier && !rejected) {
            return {
              ticker: snapshot.symbol,
              companyName: snapshot.name,
              href: `/stock/${snapshot.symbol.toLowerCase()}`,
              date: todayEt,
              price: snapshot.price,
              dayChangePercent: snapshot.dayChangePercent,
              afterHoursChangePercent: snapshot.afterHoursChangePercent,
              status,
              whatChanged: tapeLine(snapshot, status, eventDays),
              thesis: "Today's source-bound evidence check is still running.",
              previewThesis: "Today's evidence check is still running",
              whyItMatters:
                "AMM has not recorded today's research outcome yet. No unchanged or directional conclusion is inferred from missing work.",
              evidence: [],
              votes: { support: 0, oppose: 0, uncertain: 0, unavailable: 5 },
              majorityReason:
                "The daily check must complete before AMM records an analyst conclusion.",
              holdBackReason: null,
              flipCondition: null,
              nextEvent: snapshot.nextEvent,
              editorialScore: 0,
              hasResearch: false,
              dailyTracking: {
                status: "pending",
                date: todayEt,
                outcome: null,
                checkedAt: null,
              },
              lifecycle: null,
              signal: null,
              movement: null,
            };
          }
          const hook = dossier?.emailHook;
          const acceptedHook = acceptedDossier?.emailHook;
          const thesisObservation = rejected?.thesisObservation;
          const fallbackHeadline = "NO NEW THESIS CLEARED 3/5";
          const evidence = rejected
            ? rejected.citations
                .slice(0, 2)
                .map((source) => `[${source.title}](${source.url})`)
            : hook
              ? [hook.primaryEvidence, ...hook.secondaryEvidence.slice(0, 1)]
              : [];
          const holdBackReason = rejected
            ? `${rejected.votesOppose} opposed, ${
                rejected.votesUncertain
              } were uncertain, and ${
                rejected.votesUnavailable ?? 0
              } were unavailable. The factual change is preserved, but no new directional state was admitted.`
            : hook
              ? [
                hook.confidence.dissentReason,
                hook.confidence.uncertaintyReason,
              ]
                .filter((item): item is string => Boolean(item))
                .join(" ") || null
              : null;
          const lifecycle =
            acceptedDossier?.thesisLifecycle ??
            (thesisObservation
              ? {
                  id: thesisObservation.lifecycleId,
                  openedDate: thesisObservation.openedDate,
                  observationIndex: thesisObservation.observationIndex,
                  observationStatus: "open" as const,
                  latestSignal: thesisObservation.signal,
                }
              : null);
          const fallbackSignal =
            acceptedDossier?.thesisLifecycle?.latestSignal ??
            acceptedHook?.signal ??
            thesisObservation?.signal ??
            null;
          const movementVotes = hook?.votes ?? {
            support: rejected!.votesSupport,
            oppose: rejected!.votesOppose,
            uncertain: rejected!.votesUncertain,
            unavailable:
              rejected!.votesUnavailable ??
              Math.max(
                0,
                5 -
                  rejected!.votesSupport -
                  rejected!.votesOppose -
                  rejected!.votesUncertain,
              ),
          };
          let movement: DeskPriorityCard["movement"] = null;
          let displaySignal: DeskPriorityCard["signal"] = fallbackSignal;

          if (fallbackSignal) {
            const [history, filings, storedMovement] = await Promise.all([
              getDossierHistory<Dossier>(ticker, 130).catch(
                () => [] as Dossier[],
              ),
              getPeriodicFilingsSnapshot(ticker, 4).catch(() => []),
              lifecycle
                ? getThesisMovementObservations({
                    ticker,
                    lifecycleId: lifecycle.id,
                    openedDate: lifecycle.openedDate,
                    limit: 130,
                  }).catch(() => [] as ThesisMovementObservation[])
                : Promise.resolve([] as ThesisMovementObservation[]),
            ]);
            const lifecycleHistory = lifecycle
              ? history
                  .filter(
                    (item) =>
                      item.thesisLifecycle?.id === lifecycle.id ||
                      (!item.thesisLifecycle &&
                        item.date === lifecycle.openedDate),
                  )
                  .map(dossierMovementObservation)
              : acceptedDossier
                ? [dossierMovementObservation(acceptedDossier)]
                : [];
            const acceptedDates = new Set(lifecycleHistory.map((item) => item.date));
            let lastAdmittedScore = signalScore(fallbackSignal);
            let observations = mergeThesisMovementObservations(
              storedMovement,
              lifecycleHistory,
            ).map((item) => {
              if (acceptedDates.has(item.date)) {
                lastAdmittedScore = item.score;
                return item;
              }
              // Historical rejected/evidence-only receipts remain useful
              // review points, but cannot carry their old proposed status or
              // mutate the last council-admitted directional score.
              return { ...item, status: "open" as const, score: lastAdmittedScore };
            });
            if (
              rejected &&
              thesisObservation &&
              lifecycle?.id === thesisObservation.lifecycleId
            ) {
              const existingToday = observations.find(
                (item) => item.date === rejected.date,
              );
              const beforeToday = observations.filter((item) => item.date < rejected.date);
              observations = mergeThesisMovementObservations(
                observations.filter((item) => item.date !== rejected.date),
                [nextObservationFromReview({
                  date: rejected.date,
                  observedAt: rejected.generatedAt,
                  status: "open",
                  signal: fallbackSignal,
                  votes: movementVotes,
                  prior: beforeToday.at(-1) ?? null,
                  index: existingToday?.index ?? Math.max(
                    thesisObservation.observationIndex,
                    (beforeToday.at(-1)?.index ?? 0) + 1,
                  ),
                  auditId: rejected.rejectionAuditId,
                })],
              );
            }
            movement = buildThesisMovementView({
              observations,
              fallbackSignal,
              fallbackVotes: movementVotes,
              window: thesisMovementWindow({
                openedDate:
                  lifecycle?.openedDate ??
                  acceptedDossier?.date ??
                  rejected?.date ??
                  todayEt,
                filings,
                nextEvent: snapshot.nextEvent,
              }),
            });
            displaySignal = {
              ...signalFromThesisScore(signalScore(fallbackSignal)),
              horizonSessions: fallbackSignal.horizonSessions,
            };
          }

          return {
            ticker: snapshot.symbol,
            companyName: snapshot.name,
            href: `/stock/${snapshot.symbol.toLowerCase()}`,
            date: dossier?.date ?? rejected?.date ?? todayEt,
            price: snapshot.price,
            dayChangePercent: snapshot.dayChangePercent,
            afterHoursChangePercent: snapshot.afterHoursChangePercent,
            status,
            whatChanged:
              rejected?.whatChanged ??
              hook?.whatChanged ??
              tapeLine(snapshot, status, eventDays),
            thesis: rejected
              ? acceptedDossier?.thesisLifecycle?.canonicalThesis ??
                acceptedHook?.thesis ??
                thesisObservation?.subjectPunchline ??
                fallbackHeadline
              : hook
                ? decisionThesis(snapshot.symbol, hook)
                : fallbackHeadline,
            previewThesis: rejected
              ? acceptedDossier?.thesisLifecycle?.canonicalSubjectPunchline ??
                acceptedHook?.subjectPunchline ??
                thesisObservation?.subjectPunchline ??
                fallbackHeadline
              : hook?.subjectPunchline ?? fallbackHeadline,
            whyItMatters: rejected
              ? rejectedDecisionReason(rejected)
              : dossier?.signalCase.mechanism ?? fallbackHeadline,
            evidence,
            votes: rejected ? {
              support: rejected.votesSupport,
              oppose: rejected.votesOppose,
              uncertain: rejected.votesUncertain,
              unavailable:
                rejected.votesUnavailable ??
                Math.max(
                  0,
                  5 -
                    rejected.votesSupport -
                    rejected.votesOppose -
                    rejected.votesUncertain,
                ),
            } : hook?.votes ?? { support: 0, oppose: 0, uncertain: 0, unavailable: 5 },
            majorityReason: rejected
              ? rejectedDecisionReason(rejected)
              : hook?.confidence.majorityReason ?? fallbackHeadline,
            holdBackReason,
            flipCondition: acceptedHook?.confidence.flipCondition ?? null,
            nextEvent: snapshot.nextEvent,
            editorialScore: rejected ? 0 : hook?.editorialStrength.score ?? 0,
            hasResearch: Boolean(acceptedDossier || rejected),
            dailyTracking: dailyCheck
              ? {
                  status: "complete",
                  date: dailyCheck.date,
                  outcome: dailyCheck.outcome,
                  checkedAt: dailyCheck.checkedAt,
                }
              : {
                  status: "pending",
                  date: todayEt,
                  outcome: null,
                  checkedAt: null,
                },
            lifecycle: acceptedDossier?.thesisLifecycle
              ? {
                  openedDate: acceptedDossier.thesisLifecycle.openedDate,
                  observationIndex:
                    movement?.observations.at(-1)?.index ??
                    acceptedDossier.thesisLifecycle.observationIndex,
                  status: acceptedDossier.thesisLifecycle.observationStatus,
                }
              : thesisObservation
                ? {
                    openedDate: thesisObservation.openedDate,
                    observationIndex:
                      movement?.observations.at(-1)?.index ??
                      thesisObservation.observationIndex,
                    status: "open",
                  }
                : null,
            signal: displaySignal,
            movement,
          };
        },
      ),
    )
  ).filter((card): card is DeskPriorityCard => card !== null);

  cards.sort((left, right) => {
    const leftQuiet = left.status === "quiet";
    const rightQuiet = right.status === "quiet";
    if (leftQuiet !== rightQuiet) return leftQuiet ? 1 : -1;
    return priority(right) - priority(left);
  });

  return cards;
}
