"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import Md from "@/components/Md";
import styles from "@/components/DeskPriorityStack.module.css";
import Tri from "@/components/Tri";
import { cardPreviewHook } from "@/lib/cardPreview";
import type { ThesisMovementView } from "@/lib/thesisMovement";

export interface DeskPriorityCard {
  ticker: string;
  companyName: string;
  href: string;
  date: string;
  price: number | null;
  dayChangePercent: number | null;
  afterHoursChangePercent: number | null;
  status: "flag" | "event" | "quiet";
  whatChanged: string;
  thesis: string;
  previewThesis: string;
  whyItMatters: string;
  evidence: string[];
  votes: { support: number; oppose: number; uncertain: number; unavailable?: number };
  majorityReason: string;
  holdBackReason: string | null;
  flipCondition: string | null;
  nextEvent: string | null;
  editorialScore: number;
  hasResearch: boolean;
  dailyTracking: {
    status: "complete" | "pending";
    date: string;
    outcome: "published" | "no-directional-read" | "evidence-unchanged" | null;
    checkedAt: number | null;
  };
  lifecycle: {
    openedDate: string;
    observationIndex: number;
    status: "opened" | "strengthened" | "weakened" | "resolved" | "invalidated" | "replaced" | "open";
  } | null;
  signal: {
    direction: "UP" | "DOWN" | "NEUTRAL";
    strength: "GENTLE" | "MODERATE" | "STRONG" | "NEUTRAL";
    horizonSessions: { min: number; max: number };
  } | null;
  movement: ThesisMovementView | null;
}

function dateLabel(value: string): string {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
}

function changeLabel(value: number | null): string {
  if (value == null) return "—";
  if (Math.abs(value) < 0.005) return "0.00%";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function VoteMarks({ votes }: { votes: DeskPriorityCard["votes"] }) {
  const marks = useMemo(() => [
    ...Array.from({ length: votes.support }, () => "filled" as const),
    ...Array.from({ length: Math.max(0, 5 - votes.support) }, () => "outline" as const),
  ].slice(0, 5), [votes]);

  return (
    <span
      className={styles.voteMarks}
      aria-label={`${votes.support} analysts agree, ${votes.oppose} disagree, ${votes.uncertain} are unsure`}
    >
      {marks.map((mark, index) => <span key={`${mark}-${index}`} className={styles[mark]} aria-hidden />)}
    </span>
  );
}

function countWord(value: number): string {
  return ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE"][value] ?? String(value);
}

function signalLabel(card: DeskPriorityCard): string {
  if (!card.signal) return "NO NEW SIGNAL";
  if (card.signal.direction === "NEUTRAL") return "NEUTRAL";
  const strength = card.signal.strength === "STRONG" ? "STRONG" : "GENTLE";
  return `${strength} ${card.signal.direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`;
}

function signalPosition(signal: NonNullable<DeskPriorityCard["signal"]>): number {
  if (signal.direction === "NEUTRAL") return 50;
  if (signal.direction === "UP") {
    if (signal.strength === "STRONG") return 100;
    return 75;
  }
  if (signal.strength === "STRONG") return 0;
  return 25;
}

function datePosition(date: string, startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T12:00:00Z`);
  const end = Date.parse(`${endDate}T12:00:00Z`);
  const value = Date.parse(`${date}T12:00:00Z`);
  if (![start, end, value].every(Number.isFinite) || end <= start) return 0;
  return Math.max(0, Math.min(100, ((value - start) / (end - start)) * 100));
}

function scoreTop(score: number): number {
  return 50 - Math.max(-2, Math.min(2, score)) * 15;
}

function movementPath(movement: ThesisMovementView): string {
  const points = movement.observations.map((item) => ({
    x: datePosition(item.date, movement.window.startDate, movement.window.endDate),
    y: scoreTop(item.score),
  }));
  if (points.length === 0) return "";
  // The active thesis is anchored to the filing that opened the reporting
  // cycle. Historical daily observations may begin later, so extend the first
  // admitted state back to that truthful lifecycle boundary rather than
  // leaving most of the chart empty.
  let path = `M 0 ${points[0].y.toFixed(2)}`;
  for (const point of points) path += ` H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`;
  return path;
}

function ThesisMovement({ movement }: { movement: ThesisMovementView }) {
  const points = movement.observations.map((item, index) => ({
    ...item,
    x: datePosition(item.date, movement.window.startDate, movement.window.endDate),
    y: scoreTop(item.score),
    changed: index === 0
      ? Math.abs(item.score) > 0.25
      : item.score !== movement.observations[index - 1].score,
  }));
  const opening = points[0];
  const current = points.at(-1);
  const currentX = current?.x ?? 0;
  const currentY = current?.y ?? scoreTop(movement.currentScore);
  const historicalChanges = points.filter((point, index) => point.changed && index < points.length - 1);

  return (
    <section
      className={styles.thesisMovement}
      aria-label={`Reporting cycle from ${movement.window.startLabel} to ${movement.window.endLabel}. Thesis opened ${opening ? dateLabel(opening.date) : "during this cycle"}. Current ${movement.currentLabel}, ${movement.currentSupport} of ${movement.currentTotal} analysts agree.`}
    >
      <header>
        <h4>THESIS MOVEMENT</h4>
        <p>
          CURRENT <span aria-hidden>·</span> {movement.currentLabel} <span aria-hidden>·</span>{" "}
          {movement.currentSupport}/{movement.currentTotal}
        </p>
      </header>
      <div className={styles.movementPlot}>
        {points.length > 0 && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <path d={movementPath(movement)} />
          </svg>
        )}
        {opening && (
          <span
            className={styles.movementOpening}
            style={{ left: "0%", top: `${opening.y}%` }}
            aria-hidden
          />
        )}
        {historicalChanges.map((point) => (
          <span
            key={`${point.date}-${point.index}`}
            className={styles.movementChange}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            aria-hidden
          >
            <Tri size="8px" />
          </span>
        ))}
        {current && (
          <span
            className={styles.movementCurrent}
            style={{ left: `${currentX}%`, top: `${currentY}%` }}
            aria-hidden
          />
        )}
        {current && (
          <span
            className={styles.movementFuture}
            style={{ left: `${currentX}%`, top: `${currentY}%` }}
            aria-hidden
          />
        )}
      </div>
      <footer>
        <span>{movement.window.startLabel}</span>
        <span>{movement.window.endLabel}</span>
      </footer>
    </section>
  );
}

function DirectionalRead({ card }: { card: DeskPriorityCard }) {
  const isPending = card.dailyTracking.status === "pending";
  if (!card.signal) {
    const lifecycleState = card.lifecycle
      ? {
          opened: "ACTIVE THESIS OPENED",
          strengthened: "ACTIVE THESIS STRENGTHENED",
          weakened: "ACTIVE THESIS WEAKENED",
          resolved: "PRIOR THESIS RESOLVED",
          invalidated: "PRIOR THESIS INVALIDATED",
          replaced: "PRIOR THESIS REPLACED",
          open: "ACTIVE THESIS UNCHANGED",
        }[card.lifecycle.status]
      : null;
    return (
      <section
        className={`${styles.directionalRead} ${styles.noDirectionalRead}`}
        aria-label={isPending ? "Today's evidence check is still running" : "No new directional read"}
      >
        <div className={styles.directionSummary}>
          <p>{isPending ? "DAILY TRACKING" : "DAILY OUTCOME"}</p>
          <strong>
            {isPending ? "TODAY'S EVIDENCE CHECK IS RUNNING" : "NO NEW DIRECTIONAL READ"}
          </strong>
        </div>
        <div className={styles.noDirectionReceipt}>
          {isPending
            ? <strong>NO DAILY CONCLUSION HAS BEEN RECORDED YET</strong>
            : lifecycleState && <strong>{lifecycleState} TODAY</strong>}
          <span>
            {isPending
              ? "The last verified thesis remains on file until this check completes."
              : `${card.votes.support} support · ${card.votes.oppose} oppose · ${card.votes.uncertain} uncertain${
                  (card.votes.unavailable ?? 0) > 0 ? ` · ${card.votes.unavailable} unavailable` : ""
                }`}
          </span>
        </div>
      </section>
    );
  }

  const position = signalPosition(card.signal);
  const scaleStyle = { "--signal-position": `${position}%` } as CSSProperties;
  const stops = [
    { side: "down", strength: "STRONG" },
    { side: "down", strength: "GENTLE" },
    { side: "neutral", strength: "NEUTRAL" },
    { side: "up", strength: "GENTLE" },
    { side: "up", strength: "STRONG" },
  ] as const;

  return (
    <section
      className={styles.directionalRead}
      data-direction={card.signal.direction}
      aria-label={`${isPending ? "Last verified read" : "Current read"}: ${signalLabel(card)}. ${card.movement ? `Tracked across the current reporting cycle with ${card.movement.currentSupport} of ${card.movement.currentTotal} analysts agreeing.` : ""}`}
    >
      <div className={styles.directionSummary}>
        <p>{isPending ? "LAST VERIFIED DIRECTIONAL READ" : "DIRECTIONAL READ"}</p>
        <strong>{signalLabel(card)}</strong>
        {isPending && (
          <span className={styles.pendingTracking}>
            TODAY&apos;S EVIDENCE CHECK IS RUNNING
          </span>
        )}
      </div>

      <div className={styles.signalMeter} style={scaleStyle}>
        <div className={styles.signalTrack} aria-hidden />
        <div className={styles.signalStops} aria-hidden>
          {stops.map((stop) => (
            <span key={`${stop.side}-${stop.strength}`} className={`${styles.signalStop} ${styles[stop.side]}`}>
              <i />
              <b>{stop.strength}</b>
              {stop.side !== "neutral" && <em>{stop.side === "up" ? "UPSIDE" : "DOWNSIDE"}</em>}
            </span>
          ))}
        </div>
        <span className={styles.signalMarker} aria-hidden>
          <span><Tri size="13px" /></span>
        </span>
      </div>

      {card.movement && <ThesisMovement movement={card.movement} />}
    </section>
  );
}

function PreviewCard({
  card,
  rank,
  onSelect,
}: {
  card: DeskPriorityCard;
  rank: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.preview} ${card.status === "quiet" ? styles.quietPreview : ""}`}
      onClick={onSelect}
      aria-label={`Open ${card.ticker}, card ${rank}`}
    >
      <span className={`${styles.previewRail} ${card.status === "quiet" ? styles.quietRail : ""}`}>
        {String(rank).padStart(2, "0")}
      </span>
      <span className={styles.previewTicker}>{card.ticker}</span>
      <span className={styles.previewSummary}>
        <strong>{signalLabel(card)} · {card.votes.support}/5</strong>
        <span className={styles.previewThesis}>{cardPreviewHook(card.previewThesis)}</span>
      </span>
      <span className={styles.previewArrow} aria-hidden>⌄</span>
    </button>
  );
}

export default function DeskPriorityStack({ cards }: { cards: DeskPriorityCard[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const total = cards.length;
  const currentIndex = total > 0 ? activeIndex % total : 0;

  if (total === 0) {
    return (
      <div className={styles.empty}>
        <p>No company cards are available yet.</p>
        <Link href="/desk/new">Add a company →</Link>
      </div>
    );
  }

  const active = cards[currentIndex];
  const nextIndex = (currentIndex + 1) % total;
  const evidence = active.evidence.slice(0, 2);
  const support = active.votes.support;
  const holdBack = active.votes.oppose + active.votes.uncertain + (active.votes.unavailable ?? 0);

  function moveWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % total);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + total) % total);
    }
  }

  return (
    <section
      className={styles.experience}
      aria-label="Desk priorities"
      tabIndex={0}
      onKeyDown={moveWithKeyboard}
    >
      <div className={styles.controls}>
        <span>{active.ticker} · {currentIndex + 1} OF {total}</span>
        <button
          type="button"
          onClick={() => setActiveIndex((index) => (index - 1 + total) % total)}
          aria-label="Previous company"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => setActiveIndex((index) => (index + 1) % total)}
          aria-label="Next company"
        >
          ↓
        </button>
      </div>

      <div className={styles.stack}>
        <span className={styles.layerOne} aria-hidden />
        <span className={styles.layerTwo} aria-hidden />

        <article className={styles.activeCard}>
          <div className={`${styles.rankRail} ${active.status === "quiet" ? styles.quietRail : ""}`}>
            {String(currentIndex + 1).padStart(2, "0")}
          </div>

          <div className={styles.cardBody}>
            <header className={styles.cardHeader}>
              <div>
                <p>{dateLabel(active.date)}</p>
                <h2>{active.ticker}</h2>
              </div>
              <p className={styles.price}>
                {active.price == null ? "—" : `$${active.price.toFixed(2)}`}
                <span aria-hidden>·</span>
                <strong data-positive={(active.dayChangePercent ?? 0) >= 0}>
                  {changeLabel(active.dayChangePercent)}
                </strong>
              </p>
            </header>

            <div
              className={styles.dailyTracking}
              data-status={active.dailyTracking.status}
            >
              <strong>
                {active.dailyTracking.status === "complete"
                  ? active.dailyTracking.outcome === "published"
                    ? "TODAY'S THESIS CHECK COMPLETE"
                    : active.dailyTracking.outcome === "evidence-unchanged"
                      ? "TODAY'S EVIDENCE CHECK COMPLETE · NO MATERIAL CHANGE"
                      : "TODAY'S CHECK COMPLETE · NO NEW DIRECTIONAL READ"
                  : "TODAY'S THESIS CHECK IS RUNNING"}
              </strong>
              <span>
                {active.dailyTracking.status === "complete"
                  ? `Verified ${dateLabel(active.dailyTracking.date)}`
                  : "Last verified research stays visible until the new evidence check finishes."}
              </span>
            </div>

            <div className={styles.leadGrid}>
              <div className={styles.row}>
                <h3>WHAT CHANGED</h3>
                <div className={styles.copy}><Md text={active.whatChanged} /></div>
              </div>

              <div className={styles.row}>
                <h3>THE THESIS</h3>
                <div className={styles.thesis}>
                  <p>{cardPreviewHook(active.previewThesis, 22)}</p>
                </div>
              </div>
            </div>

            <DirectionalRead card={active} />

            <div className={styles.analysisGrid}>
              <div className={styles.row}>
                <h3>WHY IT MATTERS</h3>
                <div className={styles.copy}><Md text={active.whyItMatters} /></div>
              </div>

              <div className={styles.row}>
                <h3>EVIDENCE</h3>
                <div className={styles.evidence}>
                  {evidence.length > 0
                    ? evidence.map((item, index) => <Md key={index} text={item} />)
                    : <p>No cited evidence cleared today.</p>}
                </div>
              </div>
            </div>

            <div className={`${styles.row} ${styles.councilRow}`}>
              <h3>ANALYST AGREEMENT</h3>
              <div className={styles.council}>
                <div className={styles.voteSummary}>
                  <VoteMarks votes={active.votes} />
                  <strong>{support}/5 AGREE</strong>
                </div>
                <div className={styles.confidenceBreakdown}>
                  <section>
                    <h4>{countWord(support)} AGREE</h4>
                    <div className={styles.copy}><Md text={active.majorityReason} /></div>
                  </section>
                  {holdBack > 0 && active.holdBackReason && (
                    <section>
                      <h4>{countWord(holdBack)} {holdBack === 1 ? "IS" : "ARE"} NOT CONVINCED</h4>
                      <div className={styles.copy}><Md text={active.holdBackReason} /></div>
                    </section>
                  )}
                  {active.flipCondition && (
                    <section>
                      <h4>WHAT WOULD CHANGE THEIR VIEW</h4>
                      <div className={styles.copy}><Md text={active.flipCondition} /></div>
                    </section>
                  )}
                </div>
              </div>
            </div>

            <div className={`${styles.row} ${styles.watchRow}`}>
              <h3>WATCH NEXT</h3>
              <div className={styles.watchCopy}>
                <div>
                  {active.nextEvent && <p>{active.nextEvent}</p>}
                  {!active.nextEvent && <p>No dated company event.</p>}
                </div>
                <Link href={active.href}>
                  {active.hasResearch ? "Full research" : "Open the file"} <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
          </div>
        </article>

        {total > 1 && (
          <div className={styles.previewStack}>
            <PreviewCard
              card={cards[nextIndex]}
              rank={nextIndex + 1}
              onSelect={() => setActiveIndex(nextIndex)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
