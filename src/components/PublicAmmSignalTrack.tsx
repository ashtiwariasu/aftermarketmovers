import Tri from "@/components/Tri";
import type { PublicSignalTrackView } from "@/lib/signalTrack";
import styles from "./PublicAmmSignalTrack.module.css";

function shortDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed).toUpperCase();
}

function move(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "AWAITING FIRST CLOSE";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signalLabel(view: PublicSignalTrackView): string {
  return `${view.strength} ${view.direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`;
}

function stateLabel(view: PublicSignalTrackView): string {
  switch (view.state) {
    case "INCOMPLETE":
      return "TRACKING NEEDS A COMPLETE PUBLICATION BASELINE";
    case "AWAITING_FIRST_CLOSE":
      return "AWAITING FIRST COMPLETE CLOSE";
    case "REVIEW_WINDOW":
      return "FINAL REVIEW WINDOW IN PROGRESS";
    case "FINAL":
      return "REVIEW WINDOW COMPLETE";
    default:
      return "TRACKING IN PROGRESS";
  }
}

function linePoints(view: PublicSignalTrackView): string {
  return [
    "0,50",
    ...view.points.map((point) => `${point.xPercent},${point.yPercent}`),
  ].join(" ");
}

export default function PublicAmmSignalTrack({
  view,
}: {
  view: PublicSignalTrackView;
}) {
  const reviewStart =
    ((view.horizon.min - 0.5) / view.horizon.max) * 100;
  const latestPoint = view.points.at(-1) ?? null;
  const observedSessions = Math.min(view.sessionCount, view.horizon.max);

  return (
    <section
      className={styles.track}
      aria-label={`${shortDate(view.issueDate)} published AMM signal and subsequent market path`}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>AMM SIGNAL TRACK</p>
          <h2>{signalLabel(view)}</h2>
          <p className={styles.meta}>
            PUBLISHED {shortDate(view.issueDate)} · {observedSessions} CLOSE
            {observedSessions === 1 ? "" : "S"} OBSERVED
          </p>
        </div>
        <div className={styles.legend} aria-label="Chart legend">
          <span>
            <i className={styles.forecastLegend}>
              <Tri size="13px" />
            </i>
            PUBLISHED READ
          </span>
          <span>
            <i className={styles.actualLegend} />
            OBSERVED PRICE PATH
          </span>
        </div>
      </header>

      <div className={styles.chartFrame}>
        <div className={styles.bandLabels} aria-hidden>
          <span>STRONG UPSIDE</span>
          <span>GENTLE UPSIDE</span>
          <span>NEUTRAL</span>
          <span>GENTLE DOWNSIDE</span>
          <span>STRONG DOWNSIDE</span>
        </div>

        <div className={styles.plot}>
          <div className={`${styles.band} ${styles.strongUpside}`} />
          <div className={`${styles.band} ${styles.gentleUpside}`} />
          <div className={`${styles.band} ${styles.neutral}`} />
          <div className={`${styles.band} ${styles.gentleDownside}`} />
          <div className={`${styles.band} ${styles.strongDownside}`} />
          <div
            className={styles.reviewWindow}
            style={{ left: `${reviewStart}%` }}
            aria-hidden
          />
          <span className={styles.reviewLabel}>
            SESSIONS {view.horizon.min}–{view.horizon.max} · FINAL REVIEW
          </span>

          <div
            className={styles.forecastLine}
            style={{ top: `${view.forecastYPercent}%` }}
            aria-hidden
          >
            <span className={styles.forecastMarker}>
              <Tri size="20px" />
            </span>
            <span className={styles.forecastText}>
              PUBLISHED · {signalLabel(view)}
            </span>
          </div>

          {view.points.length > 0 ? (
            <>
              <svg
                className={styles.actualLine}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
              >
                <polyline points={linePoints(view)} />
              </svg>
              <span className={`${styles.actualPoint} ${styles.startPoint}`} aria-hidden />
              {view.points.map((point, index) => {
                const current = index === view.points.length - 1;
                return (
                  <span
                    key={`${point.date}-${point.session}`}
                    className={`${styles.actualPoint} ${current ? styles.currentPoint : ""}`}
                    style={{
                      left: `${point.xPercent}%`,
                      top: `${point.yPercent}%`,
                    }}
                    title={`Session ${point.session} · ${shortDate(point.date)} · ${move(point.cumulativeReturnPct)}`}
                    aria-hidden
                  />
                );
              })}
              {latestPoint ? (
                <span
                  className={`${styles.actualText} ${
                    latestPoint.xPercent > 72 ? styles.actualTextReverse : ""
                  }`}
                  style={{
                    left: `${latestPoint.xPercent}%`,
                    top: `${latestPoint.yPercent}%`,
                  }}
                >
                  MARKET PATH · {move(view.observedMovePct)}
                </span>
              ) : null}
            </>
          ) : (
            <p className={styles.awaiting}>
              Market-path tracking begins after the first complete close.
            </p>
          )}
        </div>
      </div>

      <div
        className={styles.sessionRail}
        style={{
          gridTemplateColumns: `repeat(${view.horizon.max}, minmax(0, 1fr))`,
        }}
        aria-label="Published signal observation progress"
      >
        {Array.from({ length: view.horizon.max }, (_, index) => {
          const session = index + 1;
          const observed = session <= observedSessions;
          const inReview = session >= view.horizon.min;
          return (
            <span
              key={session}
              className={`${observed ? styles.observed : ""} ${
                inReview ? styles.review : ""
              }`}
              aria-label={`Session ${session}${observed ? ", observed" : ""}${
                inReview ? ", final review window" : ""
              }`}
            >
              {session}
            </span>
          );
        })}
      </div>

      <div className={styles.receipt}>
        <span>
          <small>PUBLISHED READ</small>
          <strong>{signalLabel(view)}</strong>
        </span>
        <span>
          <small>OBSERVED MOVE</small>
          <strong
            className={
              view.observedMovePct == null
                ? styles.moveNeutral
                : view.observedMovePct >= 0
                  ? styles.movePositive
                  : styles.moveNegative
            }
          >
            {move(view.observedMovePct)}
          </strong>
        </span>
        <span>
          <small>PROGRESS</small>
          <strong>
            {observedSessions} OF {view.horizon.max} CLOSES
          </strong>
        </span>
        <span>
          <small>AS OF</small>
          <strong>{shortDate(view.asOfDate)}</strong>
        </span>
      </div>

      <p className={styles.status}>{stateLabel(view)}</p>
      <p className={styles.method}>
        Observed path shows adjusted-price movement after publication,
        normalised to the stock&apos;s prior volatility. It is descriptive
        market data, not AMM&apos;s audited accuracy verdict.
      </p>

      <table className={styles.srOnly}>
        <caption>Observed closes after the published AMM signal</caption>
        <thead>
          <tr>
            <th>Session</th>
            <th>Date</th>
            <th>Move since publication</th>
          </tr>
        </thead>
        <tbody>
          {view.points.map((point) => (
            <tr key={`accessible-${point.date}-${point.session}`}>
              <td>{point.session}</td>
              <td>{point.date}</td>
              <td>{move(point.cumulativeReturnPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
