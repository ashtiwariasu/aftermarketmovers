import Tri from "@/components/Tri";
import type {
  SignalTrackAlignment,
  SignalTrackBand,
  SignalTrackProjection,
} from "@/lib/signalTrack";
import styles from "./AmmSignalTrack.module.css";

interface Props {
  projection: SignalTrackProjection;
  compact?: boolean;
}

const BAND_LABELS: Array<{ band: SignalTrackBand; label: string }> = [
  { band: "STRONG_UPSIDE", label: "STRONG UPSIDE" },
  { band: "GENTLE_UPSIDE", label: "GENTLE UPSIDE" },
  { band: "NEUTRAL", label: "NEUTRAL" },
  { band: "GENTLE_DOWNSIDE", label: "GENTLE DOWNSIDE" },
  { band: "STRONG_DOWNSIDE", label: "STRONG DOWNSIDE" },
];

function readableBand(value: SignalTrackBand | null): string {
  return value ? value.replaceAll("_", " ") : "AWAITING FIRST CLOSE";
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function move(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function shortDate(value: string): string {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed).toUpperCase();
}

function scoreTop(score: number): string {
  const clamped = Math.max(-2, Math.min(2, score));
  return `${50 - clamped * 20}%`;
}

function sessionLeft(session: number, max: number): string {
  return `${(Math.max(0, Math.min(max, session)) / max) * 100}%`;
}

function verdict(
  status: SignalTrackProjection["status"],
  alignment: SignalTrackAlignment | null,
): { primary: string; secondary: string; tone: "good" | "bad" | "open" } {
  if (status === "incomplete") {
    return {
      primary: "TRACKING STARTS AFTER THE FIRST COMPLETE CLOSE",
      secondary: "STRENGTH PROVISIONAL",
      tone: "open",
    };
  }
  if (status === "final") {
    if (alignment === "SUPPORTS") {
      return { primary: "DIRECTION HELD", secondary: "FINAL STRENGTH SET", tone: "good" };
    }
    if (alignment === "OPPOSES") {
      return { primary: "DIRECTION DID NOT HOLD", secondary: "FINAL STRENGTH SET", tone: "bad" };
    }
    return { primary: "DIRECTION FINISHED NEUTRAL", secondary: "FINAL STRENGTH SET", tone: "open" };
  }
  if (alignment === "SUPPORTS") {
    return {
      primary: "DIRECTION SUPPORTED SO FAR",
      secondary: "STRENGTH PROVISIONAL",
      tone: "good",
    };
  }
  if (alignment === "OPPOSES") {
    return {
      primary: "DIRECTION NOT SUPPORTED SO FAR",
      secondary: "STRENGTH PROVISIONAL",
      tone: "bad",
    };
  }
  return {
    primary: "DIRECTION UNRESOLVED SO FAR",
    secondary: "STRENGTH PROVISIONAL",
    tone: "open",
  };
}

function linePoints(projection: SignalTrackProjection): string {
  const points = [
    { session: 0, score: 0 },
    ...projection.points.map((point) => ({
      session: point.session,
      score: point.score,
    })),
  ];
  return points
    .map(({ session, score }) => {
      const x = (session / projection.horizon.max) * 100;
      const y = 50 - Math.max(-2, Math.min(2, score)) * 20;
      return `${x},${y}`;
    })
    .join(" ");
}

export default function AmmSignalTrack({ projection, compact = false }: Props) {
  const result = verdict(projection.status, projection.alignment);
  const observedSessions = Math.min(projection.sessionCount, projection.horizon.max);
  const currentSession = Math.max(0, observedSessions);
  const reviewStart = ((projection.horizon.min - 0.5) / projection.horizon.max) * 100;
  const forecastLabel = `${projection.strength} ${projection.direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`;
  const final = projection.status === "final";

  return (
    <section
      className={`${styles.track} ${compact ? styles.compact : ""}`}
      aria-label={`${shortDate(projection.issueDate)} AMM signal performance`}
    >
      <header className={styles.header}>
        <div>
          <h2 className={styles.heading}>AMM SIGNAL TRACK</h2>
          <p className={styles.subheading}>
            {shortDate(projection.issueDate)} FORECAST · SESSION {currentSession} OF {projection.horizon.max}
          </p>
        </div>
        <div className={`${styles.verdict} ${styles[result.tone]}`} aria-live="polite">
          <strong>{result.primary}</strong>
          <span>{result.secondary}</span>
        </div>
        <div className={styles.legend} aria-label="Chart legend">
          <span><i className={styles.forecastLegend}><Tri size="15px" /></i> PUBLISHED READ</span>
          <span><i className={styles.actualLegend} /> ACTUAL SO FAR</span>
        </div>
      </header>

      <div className={styles.chartFrame}>
        <div className={styles.bandLabels} aria-hidden>
          {BAND_LABELS.map(({ band, label }) => (
            <div key={band}>{label}</div>
          ))}
        </div>

        <div className={styles.plot}>
          {BAND_LABELS.map(({ band }) => (
            <div key={band} className={`${styles.band} ${styles[band.toLowerCase()]}`} />
          ))}
          <div
            className={styles.reviewWindow}
            style={{ left: `${reviewStart}%` }}
            aria-hidden
          />
          <span className={styles.reviewLabel}>
            FINAL REVIEW · SESSIONS {projection.horizon.min}–{projection.horizon.max}
          </span>

          <div
            className={styles.forecastLine}
            style={{ top: scoreTop(projection.forecastScore) }}
            aria-hidden
          >
            <span className={styles.forecastMarker}><Tri size="22px" /></span>
            <span className={`${styles.forecastText} ${projection.forecastScore < 0 ? styles.forecastTextAbove : ""}`}>
              PUBLISHED READ · {forecastLabel}
            </span>
          </div>

          {projection.start ? (
            <>
              <svg
                className={styles.actualLine}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
              >
                <polyline points={linePoints(projection)} />
              </svg>
              <span className={`${styles.actualPoint} ${styles.startPoint}`} aria-hidden />
              {projection.points.map((point, index) => {
                const isCurrent = index === projection.points.length - 1;
                return (
                  <span
                    key={`${point.date}-${point.session}`}
                    className={`${styles.actualPoint} ${isCurrent ? styles.currentPoint : ""}`}
                    style={{
                      left: sessionLeft(point.session, projection.horizon.max),
                      top: scoreTop(point.score),
                    }}
                    title={`Session ${point.session}: ${move(point.cumulativeReturnPct)}`}
                    aria-hidden
                  />
                );
              })}
              {projection.points.length > 0 ? (
                <span
                  className={[
                    styles.actualText,
                    currentSession > projection.horizon.max * 0.72 ? styles.actualTextReverse : "",
                    (projection.actualScore ?? 0) < -1 ? styles.actualTextAbove : "",
                  ].filter(Boolean).join(" ")}
                  style={{
                    left: sessionLeft(currentSession, projection.horizon.max),
                    top: scoreTop(projection.actualScore ?? 0),
                  }}
                >
                  ACTUAL SO FAR · {readableBand(projection.actualBand)}
                </span>
              ) : null}
            </>
          ) : (
            <p className={styles.noData}>A complete pre-publication close is required before tracking begins.</p>
          )}
        </div>
      </div>

      <div
        className={styles.sessionRail}
        style={{ gridTemplateColumns: `repeat(${projection.horizon.max}, minmax(0, 1fr))` }}
        aria-label="Forecast session progress"
      >
        {Array.from({ length: projection.horizon.max }, (_, index) => {
          const session = index + 1;
          const observed = session <= observedSessions;
          const inReview = session >= projection.horizon.min;
          return (
            <span
              key={session}
              className={`${observed ? styles.observed : ""} ${inReview ? styles.review : ""}`}
              aria-label={`Session ${session}${observed ? ", observed" : ""}${inReview ? ", final review window" : ""}`}
            >
              {session}
            </span>
          );
        })}
      </div>

      <div className={styles.receipt}>
        <span><small>PREDICTED</small><strong>{forecastLabel}</strong></span>
        <span><small>ACTUAL SO FAR</small><strong>{readableBand(projection.actualBand)}</strong></span>
        <span><small>START</small><strong>{money(projection.start?.adjustedClose)}</strong></span>
        <span><small>LAST</small><strong>{money(projection.last?.adjustedClose)}</strong></span>
        <span className={projection.move && projection.move.cumulativeReturnPct >= 0 ? styles.positive : styles.negative}>
          <small>MOVE</small><strong>{move(projection.move?.cumulativeReturnPct)}</strong>
        </span>
      </div>

      <p className={`${styles.summary} ${styles[result.tone]}`}>
        <strong>{result.primary}</strong>
        <span>·</span>
        <span>{final ? "FINAL OUTCOME USES THE REVIEW WINDOW" : `FINAL STRENGTH SET AFTER SESSIONS ${projection.horizon.min}–${projection.horizon.max}`}</span>
      </p>
      <p className={styles.method}>
        Actual position is the cumulative adjusted-price move since publication, scaled by volatility known at publication.
        Final outcome uses the average position across sessions {projection.horizon.min}–{projection.horizon.max}.
      </p>
    </section>
  );
}
