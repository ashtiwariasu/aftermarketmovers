import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import Tri from "@/components/Tri";
import styles from "./morning-note.module.css";

export const metadata: Metadata = {
  title: "Morning Note HTML prototype",
  robots: { index: false, follow: false },
};

type ScalePosition = {
  key: string;
  label: "Strong" | "Gentle" | "Neutral" | "";
  side: "down" | "neutral" | "up";
  moderate?: boolean;
  active?: boolean;
};

const scalePositions: readonly ScalePosition[] = [
  { key: "strong-down", label: "Strong", side: "down" },
  { key: "moderate-down", label: "", side: "down", moderate: true },
  { key: "gentle-down", label: "Gentle", side: "down" },
  { key: "neutral", label: "Neutral", side: "neutral" },
  { key: "gentle-up", label: "Gentle", side: "up", active: true },
  { key: "moderate-up", label: "", side: "up", moderate: true },
  { key: "strong-up", label: "Strong", side: "up" },
];

function CouncilTriangle() {
  return <Image className={styles.councilTriangle} src="/tri-brand-flat.png" width={16} height={15} alt="" />;
}

function SignalScale() {
  return (
    <div className={styles.scale} aria-label="Signal changed since July 15 from neutral to gentle upside">
      <p className={styles.movement}>Signal changed since Jul 15 · Neutral <span aria-hidden="true">→</span> Gentle upside</p>

      <div className={styles.scalePlot}>
        <span className={styles.scaleLine} aria-hidden="true" />
        <span className={`${styles.midTick} ${styles.midTickLeft}`} aria-hidden="true" />
        <span className={`${styles.midTick} ${styles.midTickRight}`} aria-hidden="true" />
        <span className={styles.movementArc} aria-hidden="true" />

        {scalePositions.map((position) => (
          <div className={styles.scalePosition} key={position.key}>
            <span
              className={`${styles.scaleNode} ${position.moderate ? styles.interstitialNode : ""} ${position.side === "neutral" ? styles.ghostNode : ""} ${position.active ? styles.activeNode : ""}`}
              aria-hidden="true"
            >
              {position.active ? (
                <span className={styles.activeWedge}>
                  <Tri size="100%" />
                </span>
              ) : null}
            </span>
            <span className={`${styles.scaleLabel} ${position.active ? styles.activeLabel : ""}`}>
              {position.label || (position.active ? "Moderate" : "\u00A0")}
            </span>
          </div>
        ))}
      </div>

      <div className={styles.directionGroups} aria-hidden="true">
        <span>Downside</span>
        <span />
        <span>Upside</span>
      </div>
    </div>
  );
}

function ImpactWindow() {
  return (
    <div
      className={styles.impact}
      aria-label="Fixed 12 week scale. Expected impact within 2 to 3 weeks."
    >
      <div className={styles.impactHeading}>
        Expected impact <span aria-hidden="true">·</span> 2–3 weeks
      </div>

      <div className={styles.ruler} aria-hidden="true">
        <span className={styles.windowShade} />
        <span className={styles.rulerLine} />
        <span className={styles.windowEnd} />
        <span className={styles.rulerTicks}>
          {Array.from({ length: 61 }, (_, session) => (
            <i
              className={`${session % 5 === 0 ? styles.majorTick : ""} ${session <= 15 ? styles.windowTick : ""}`}
              key={session}
            />
          ))}
        </span>
      </div>

      <div className={styles.rulerLabels} aria-hidden="true">
        <span>Today</span>
        <span>W2</span>
        <span>W4</span>
        <span>W6</span>
        <span>W8</span>
        <span>W10</span>
        <span>W12</span>
      </div>
    </div>
  );
}

export default function MorningNoteMockup() {
  return (
    <main className={styles.canvas}>
      <div className={styles.prototypeLabel}>
        HTML/CSS prototype <span>·</span> morning note
      </div>

      <article className={styles.email} aria-label="AMM Morning Note mockup">
        <header className={styles.masthead}>
          <div className={styles.brand}>
            <Image src="/fox-note.png" width={31} height={40} alt="" priority />
            <span>AMM</span>
            <i aria-hidden="true" />
          </div>
          <time dateTime="2026-07-19T07:00:00+10:00">Sun, Jul 19 · 7:00 AM</time>
        </header>

        <div className={styles.emailBody}>
          <p className={styles.coverage}>
            <strong>9 stocks</strong> scanned <span>·</span> <strong>6 updates</strong> <span>·</span>{" "}
            <b>1 Signal</b>
          </p>

          <section className={styles.heroCard}>
            <div className={styles.tickerRow}>
              <div>
                <h1>MSFT</h1>
                <p>−0.1% AH</p>
              </div>
              <span className={styles.asOf}>Jul 19</span>
            </div>

            <section className={styles.storyBeat}>
              <h2>What changed</h2>
              <p>
                Microsoft fell 1.82% with the broader tech selloff; no Microsoft-specific break entered the
                verified record.
              </p>
            </section>

            <section className={styles.thesis}>
              <p className={styles.thesisLabel}>AMM <i aria-hidden="true" /> Thesis</p>
              <h2>This decline is a broad-sector move, not a Microsoft-specific break.</h2>
            </section>

            <section className={styles.signal}>
              <div className={styles.signalHeader}>
                <span>AMM signal</span>
              </div>
              <h2>Gentle upside</h2>
              <SignalScale />
              <ImpactWindow />
            </section>

            <section className={styles.evidence}>
              <h2>Evidence</h2>
              <ol>
                <li>
                  Operating cash flow covered capital expenditure with $15.8B left over.
                </li>
                <li>
                  Revenue grew 18% while net income and diluted EPS grew 23%.
                </li>
              </ol>
            </section>

            <section className={styles.council}>
              <h2>Analyst agreement</h2>
              <div className={styles.voteRow} aria-label="Five analysts back the read">
                <span className={styles.triangles}>
                  {Array.from({ length: 5 }, (_, index) => <CouncilTriangle key={index} />)}
                </span>
                <strong>5/5 agree</strong>
              </div>
              <p>
                All five support: the selloff is sector-wide while Microsoft&apos;s filed economics remain intact.
              </p>
            </section>

            <Link className={styles.cta} href="/stock/msft">
              View full research in AMM Desk <span aria-hidden="true">→</span>
            </Link>
          </section>

          <p className={styles.alsoMoved}>Also moved: <a href="#meta">META</a> · <a href="#amd">AMD</a> · <a href="#pltr">PLTR</a></p>

          <footer className={styles.footer}>
            <p>Independent factual market research. Not financial, investment, tax or legal advice.</p>
            <p>Personal circumstances are not considered.</p>
            <p>Evolo Pty Ltd · 21 Pullen Rd, Everton Park QLD 4053, Australia · <a href="#unsubscribe">unsubscribe</a></p>
          </footer>
        </div>
      </article>
    </main>
  );
}
