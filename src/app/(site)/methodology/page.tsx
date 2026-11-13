import type { Metadata } from "next";
import Tri from "@/components/Tri";

export const metadata: Metadata = {
  title: "AI Stock Research Methodology",
  description:
    "How AMM turns filings, company disclosures, market data, news and noisy social signals into traceable stock research reviewed by five frontier AI analysts.",
  alternates: { canonical: "https://aftermarketmovers.com/methodology" },
};

const SECTIONS: Array<[string, React.ReactNode]> = [
  [
    "What enters the file",
    "AMM keeps primary evidence separate from reported and discovery signals. Primary evidence includes SEC filings, structured XBRL facts and company disclosures. Licensed news and market data add context. Social chatter is treated as noisy discovery evidence and cannot establish a material claim by itself.",
  ],
  [
    "Latest state, not an endless prompt",
    "Every source is retained with its original URL, publication time, first-seen time and content hash. Each new run compares the latest company facts with the previous run, carries unanswered questions forward and retrieves older evidence only when a new signal calls for it. More history improves recall without forcing all five analysts to reread an ever-growing archive.",
  ],
  [
    "Independent analyst review",
    "One analyst builds the initial thesis and evidence case. Five independent AI analysts then review the same proposition using the same focused set of evidence. They record agreement, disagreement or uncertainty and state what evidence would change their view. A thesis needs at least three supporting votes and must pass factual, citation and arithmetic checks before it can appear publicly.",
  ],
  [
    "What the signal means",
    "A public AMM signal is qualitative: upside or downside, gentle to strong, over a fixed 10–15-session research horizon. AMM does not publish percentage forecasts, target prices or buy, hold or sell recommendations. The signal summarizes a falsifiable research mechanism, not an instruction to trade.",
  ],
  [
    "Traceability and corrections",
    "Every citation links to the original source, and each published result keeps the exact evidence and AI review behind it. Contradictions and unanswered questions stay visible. Material corrections are versioned rather than silently deleted. To report an error, email hello@aftermarketmovers.com.",
  ],
  [
    "AI disclosure and limitations",
    "AMM research is substantially produced and reviewed by AI systems under deterministic evidence and compliance gates. Models can still misunderstand evidence, sources can be incomplete or delayed, and market prices can move for reasons the admitted record does not establish. AMM is operated by Evolo Pty Ltd and provides factual research, not personal financial advice.",
  ],
];

export default function Methodology() {
  return (
    <div className="max-w-[760px] pt-12 pb-6">
      <span className="pp-chip">HOW THE RESEARCH WORKS</span>
      <h1 className="pp-disp font-extrabold text-4xl sm:text-5xl tracking-tight mt-5">
        Methodology<Tri size="0.34em" />
      </h1>
      <div className="mt-10 space-y-5">
        {SECTIONS.map(([h, body], i) => (
          <section key={h as string} className="pp-card p-6">
            <div className="flex items-baseline gap-3">
              <span className="pp-disp font-extrabold text-[18px]" style={{ color: "var(--pr-orange)" }}>
                0{i + 1}
              </span>
              <h2 className="pp-disp font-extrabold text-xl">{h}</h2>
            </div>
            <p className="mt-2.5 text-[14px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
              {body}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
