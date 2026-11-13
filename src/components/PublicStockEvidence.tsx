import GetStartedCta from "@/components/GetStartedCta";
import PublicSignalTrackHistory, {
  type PublicSignalTrackRun,
} from "@/components/PublicSignalTrackHistory";
import StockShortFeature from "@/components/StockShortFeature";
import TrackedSourceLink from "@/components/TrackedSourceLink";
import Tri from "@/components/Tri";
import type { PublicShort } from "@/lib/publicShorts";
import type { Fundamentals, SecFiling } from "@/lib/sec";
import type { TickerSnapshot } from "@/lib/ticker";

export interface PublicEvidenceLink {
  title: string;
  publisher: string;
  link: string;
  stamp: string;
  publishedDate: string;
  authority: string;
  bucket: string;
  sourceCount: number;
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (absolute >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(0)}%`;
}

function filedMetric(value: number | null | undefined): string {
  return money(value);
}

function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function sourceLabel(value: string): string {
  return value.replaceAll("_", " ").toUpperCase();
}

export default function PublicStockEvidence({
  ticker,
  snapshot,
  publicEvidence,
  fundamentals,
  filings,
  news,
  eventDays,
  refreshedAt,
  dailyShort,
  signalRuns,
}: {
  ticker: string;
  snapshot: TickerSnapshot;
  publicEvidence: boolean;
  fundamentals: Fundamentals | null;
  filings: SecFiling[];
  news: PublicEvidenceLink[];
  eventDays: number | null;
  refreshedAt: string;
  dailyShort: PublicShort | null;
  signalRuns: PublicSignalTrackRun[];
}) {
  if (!publicEvidence) {
    return (
      <section className="pp-card pp-shadow max-w-[760px] mx-auto mt-9 p-7 sm:p-10">
        <p
          className="pp-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: "var(--pr-orange)" }}
        >
          Supported US-listed company
        </p>
        <h2 className="pp-disp font-extrabold text-3xl sm:text-4xl leading-tight mt-3">
          Build the AMM file for {ticker}.
        </h2>
        <p
          className="mt-4 text-[15px] leading-relaxed max-w-[620px]"
          style={{ color: "var(--pr-dim)" }}
        >
          Add {snapshot.name} to your AMM subscription. AMM will collect its filings,
          market activity, news and relevant social sources, then the five
          analysts will build and challenge the thesis.
        </p>
        <GetStartedCta
          ticker={ticker}
          plan="pro"
          authMode="sign-up"
          analyticsPlacement="stock_long_tail_gate"
          className="pp-btn pp-btn-orange text-[14px] px-5 py-3 mt-6"
        >
          Track {ticker} for $25 →
        </GetStartedCta>
        <p
          className="pp-mono text-[10px] mt-3"
          style={{ color: "var(--pr-faint)" }}
        >
          $25/month · up to 3 companies · cancel any time
        </p>
      </section>
    );
  }

  const filedFacts = fundamentals
    ? [
        ["Revenue", money(fundamentals.revenue), percent(fundamentals.revenueYoY)],
        ["Net income", money(fundamentals.netIncome), percent(fundamentals.netIncomeYoY)],
        [
          "Diluted EPS",
          fundamentals.eps == null ? "—" : `$${fundamentals.eps.toFixed(2)}`,
          percent(fundamentals.epsYoY),
        ],
        ["Operating income", filedMetric(fundamentals.operatingIncome?.value), ""],
        ["Operating cash flow", filedMetric(fundamentals.operatingCashFlow?.value), ""],
        ["Capital expenditure", filedMetric(fundamentals.capitalExpenditures?.value), ""],
        [
          "Cash + short-term investments",
          filedMetric(fundamentals.cashAndShortTermInvestments?.value),
          "",
        ],
        [
          "Current + long-term debt",
          fundamentals.currentDebt && fundamentals.longTermDebt
            ? money(fundamentals.currentDebt.value + fundamentals.longTermDebt.value)
            : filedMetric(
                fundamentals.longTermDebt?.value ??
                  fundamentals.currentDebt?.value,
              ),
          "",
        ],
      ]
    : [];

  return (
    <div className="mt-8 space-y-6">
      <section className="pp-card pp-shadow p-6 sm:p-8">
        <div className="flex items-start justify-between gap-5 flex-wrap">
          <div>
            <p
              className="pp-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: "var(--pr-orange)" }}
            >
              Public evidence file
            </p>
            <h2 className="pp-disp font-extrabold text-3xl sm:text-4xl mt-2">
              {snapshot.name}
            </h2>
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="pp-chip">{filings.length} SEC FILINGS</span>
            <span className="pp-chip">{news.length} SOURCE LINKS</span>
            <span className="pp-chip">UPDATED DAILY</span>
          </div>
        </div>
        <p
          className="mt-5 text-[14.5px] leading-relaxed max-w-[820px]"
          style={{ color: "var(--pr-dim)" }}
        >
          AMM&apos;s published directional signals are tracked against subsequent
          market closes below. The original facts and source links remain
          public; the complete synthesis and analyst debate stay inside AMM.
        </p>
        <p
          className="pp-mono text-[10px] mt-4"
          style={{ color: "var(--pr-faint)" }}
        >
          FILE REFRESHED {refreshedAt}
        </p>
      </section>

      <PublicSignalTrackHistory ticker={ticker} runs={signalRuns} />

      {dailyShort ? <StockShortFeature item={dailyShort} /> : null}

      <div className="grid lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-6">
          {filedFacts.length > 0 && fundamentals && (
            <section className="pp-card p-6">
              <div className="flex items-baseline justify-between gap-4 flex-wrap">
                <div>
                  <p
                    className="pp-mono text-[10px] uppercase tracking-[0.2em]"
                    style={{ color: "var(--pr-faint)" }}
                  >
                    Company-reported numbers
                  </p>
                  <h3 className="pp-disp font-extrabold text-xl mt-1">
                    {fundamentals.fiscal} · period ended {fundamentals.asOf}
                  </h3>
                </div>
                <span className="pp-chip">SEC XBRL · NO ESTIMATES</span>
              </div>
              <div className="grid sm:grid-cols-2 mt-5">
                {filedFacts.map(([label, value, change], index) => (
                  <div
                    key={label}
                    className="py-3 sm:px-3 first:pl-0"
                    style={{
                      borderTop:
                        index > 1
                          ? "1.5px solid rgba(22,21,15,.12)"
                          : undefined,
                    }}
                  >
                    <p
                      className="pp-mono text-[9px] uppercase tracking-[0.14em]"
                      style={{ color: "var(--pr-faint)" }}
                    >
                      {label}
                    </p>
                    <p className="pp-mono font-semibold text-[14px] mt-1">
                      {value}
                      {change && change !== "—" ? (
                        <span
                          className="ml-2 text-[11px]"
                          style={{ color: "var(--pr-dim)" }}
                        >
                          {change} YoY
                        </span>
                      ) : null}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="pp-card p-6">
            <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2">
              <div>
                <p
                  className="pp-mono text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: "var(--pr-faint)" }}
                >
                  SEC filing log
                </p>
                <h3 className="pp-disp font-extrabold text-xl mt-1">
                  Original company filings
                </h3>
              </div>
              <span className="pp-chip">PRIMARY SOURCES</span>
            </div>
            <div>
              {filings.map((filing, index) => (
                <TrackedSourceLink
                  key={`${filing.url}:${filing.date}`}
                  href={filing.url}
                  ticker={ticker}
                  section="filing"
                  publisher="U.S. Securities and Exchange Commission"
                  authority="primary"
                  bucket="filing"
                  sourceId={`${filing.formLabel}:${filing.date}`}
                  className="grid grid-cols-[72px_1fr_auto] gap-3 py-3 hover:opacity-70"
                  style={{
                    borderTop:
                      index > 0
                        ? "1.5px solid rgba(22,21,15,.12)"
                        : undefined,
                  }}
                >
                  <strong className="pp-mono text-[11px]">
                    {filing.formLabel}
                  </strong>
                  <span className="text-[13.5px] leading-snug">
                    {filing.title}
                  </span>
                  <span
                    className="pp-mono text-[10px]"
                    style={{ color: "var(--pr-faint)" }}
                  >
                    {filing.date} ↗
                  </span>
                </TrackedSourceLink>
              ))}
              {filings.length === 0 && (
                <p
                  className="text-[13.5px] py-4"
                  style={{ color: "var(--pr-dim)" }}
                >
                  No filing record is currently available in the public file.
                </p>
              )}
            </div>
          </section>

          <section className="pp-card p-6">
            <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2">
              <div>
                <p
                  className="pp-mono text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: "var(--pr-faint)" }}
                >
                  News and source log
                </p>
                <h3 className="pp-disp font-extrabold text-xl mt-1">
                  Latest source links
                </h3>
              </div>
              <span className="pp-chip">ORIGINAL LINKS</span>
            </div>
            <div>
              {news.map((item, index) => (
                <TrackedSourceLink
                  key={`${item.link}:${item.title}`}
                  href={item.link}
                  ticker={ticker}
                  section="news"
                  publisher={item.publisher}
                  authority={item.authority}
                  bucket={item.bucket}
                  sourceId={`${item.publisher}:${item.publishedDate}`}
                  className="block py-3 hover:opacity-70"
                  style={{
                    borderTop:
                      index > 0
                        ? "1.5px solid rgba(22,21,15,.12)"
                        : undefined,
                  }}
                >
                  <div className="flex justify-between gap-4">
                    <strong className="text-[13.5px] leading-snug">
                      {item.title}
                    </strong>
                    <span
                      className="pp-mono text-[10px] shrink-0"
                      style={{ color: "var(--pr-faint)" }}
                    >
                      {item.stamp}
                    </span>
                  </div>
                  <p
                    className="pp-mono text-[9px] uppercase tracking-[0.1em] mt-1"
                    style={{ color: "var(--pr-faint)" }}
                  >
                    {item.publisher} · {item.authority} ·{" "}
                    {sourceLabel(item.bucket)} · {item.publishedDate}
                    {item.sourceCount > 1
                      ? ` · ${item.sourceCount} OBSERVATIONS`
                      : ""}
                  </p>
                </TrackedSourceLink>
              ))}
              {news.length === 0 && (
                <p
                  className="text-[13.5px] py-4"
                  style={{ color: "var(--pr-dim)" }}
                >
                  No source links are currently available in the public file.
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="lg:col-span-4 space-y-5">
          <section className="pp-card pp-shadow-sm p-5">
            <p
              className="pp-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: "var(--pr-faint)" }}
            >
              Market snapshot
            </p>
            <dl className="grid grid-cols-2 mt-3">
              {[
                ["Last", price(snapshot.price)],
                ["Previous close", price(snapshot.previousClose)],
                [
                  "52-week range",
                  snapshot.fiftyTwoWeekLow != null &&
                  snapshot.fiftyTwoWeekHigh != null
                    ? `${price(snapshot.fiftyTwoWeekLow)}–${price(snapshot.fiftyTwoWeekHigh)}`
                    : "—",
                ],
                [
                  "Volume",
                  snapshot.volume == null
                    ? "—"
                    : snapshot.volume.toLocaleString("en-US"),
                ],
                ["Session", snapshot.marketState || "—"],
                ["Exchange", snapshot.exchange || "—"],
              ].map(([label, value], index) => (
                <div
                  key={label}
                  className="py-3"
                  style={{
                    borderTop:
                      index > 1
                        ? "1.5px solid rgba(22,21,15,.12)"
                        : undefined,
                  }}
                >
                  <dt
                    className="pp-mono text-[9px] uppercase tracking-[0.12em]"
                    style={{ color: "var(--pr-faint)" }}
                  >
                    {label}
                  </dt>
                  <dd className="pp-mono font-semibold text-[12px] mt-1">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {snapshot.nextEvent && (
            <section
              className="rounded-[14px] p-5"
              style={{
                background: "var(--pr-ink)",
                color: "var(--pr-paper)",
              }}
            >
              <p
                className="pp-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: "var(--pr-lime)" }}
              >
                Next company event
              </p>
              <p className="pp-disp font-extrabold text-[17px] mt-2 leading-snug">
                {snapshot.nextEvent}
              </p>
              <p
                className="pp-mono text-[10px] mt-2"
                style={{ color: "rgba(244,241,234,.62)" }}
              >
                {eventDays == null
                  ? "MONITORED"
                  : eventDays === 0
                    ? "TODAY"
                    : eventDays > 0
                      ? `IN ${eventDays} DAYS`
                      : "DATE PASSED · AWAITING UPDATE"}
              </p>
            </section>
          )}

          <section
            className="rounded-[14px] p-5"
            style={{
              background: "var(--pr-ink)",
              color: "var(--pr-paper)",
              boxShadow: "6px 6px 0 var(--pr-orange)",
            }}
          >
            <p
              className="pp-mono text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--pr-lime)" }}
            >
              <Tri size="10px" /> AMM analysis
            </p>
            <h3 className="pp-disp font-extrabold text-2xl leading-tight mt-3">
              The evidence is public. The synthesis is AMM.
            </h3>
            <p
              className="text-[13.5px] leading-relaxed mt-3"
              style={{ color: "rgba(244,241,234,.7)" }}
            >
              Five analysts determine what matters, challenge the thesis and
              retain every disagreement in your private company file.
            </p>
            <GetStartedCta
              ticker={ticker}
              plan="pro"
              authMode="sign-up"
              analyticsPlacement="public_stock_evidence"
              className="pp-btn text-[13px] px-4 py-3 mt-5 w-full"
              style={{
                background: "var(--pr-lime)",
                color: "var(--pr-ink)",
              }}
            >
              Analyse {ticker} for $25 →
            </GetStartedCta>
            <p
              className="pp-mono text-[9px] mt-3"
              style={{ color: "rgba(244,241,234,.46)" }}
            >
              $25/MONTH · 3 COMPANIES · CANCEL ANY TIME
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
