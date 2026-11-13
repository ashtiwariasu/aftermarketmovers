// Council page content. Structured objects, one per covered ticker.
// GOOGL v0 = pre-earnings baseline drafted for the Jul 22 launch event;
// replace positions with the five-seat council run output
// before the event. Claims are metric-resolvable on purpose — every one
// gets publicly scored after the filing.

export interface CouncilClaim {
  id: string;
  claim: string;
  resolvesBy: string;
  status: "open" | "resolved_correct" | "resolved_incorrect" | "resolved_partial";
}

export interface CouncilSeat {
  seat: string;
  focus: string;
  position: string;
}

export interface CouncilPage {
  ticker: string;
  company: string;
  asOf: string;
  informationCutoff: string;
  eventNote: {
    title: string;
    whyItMatters: string;
    bottomLine: string;
    keyStats: string[];
  };
  split: {
    vote: string;
    question: string;
    majority: string;
    dissent: string;
    nextResolutionEvent: string;
  };
  seats: CouncilSeat[];
  claims: CouncilClaim[];
}

export const COUNCIL_PAGES: Record<string, CouncilPage> = {
  GOOGL: {
    ticker: "GOOGL",
    company: "Alphabet Inc.",
    asOf: "2026-07-12",
    informationCutoff: "2026-07-12T23:59:59+10:00",
    eventNote: {
      title:
        "Pre-earnings baseline: Alphabet reports Q2 2026 results on July 22 after the close",
      whyItMatters:
        "This is the first mega-cap AI-economy result since the June selloff repriced the sector on rate fears and AI capex skepticism. The market's central question has shifted from 'is Search safe?' to 'is the AI capital-expenditure ramp paying for itself?' — and Alphabet, which spends among the most and discloses cloud economics quarterly, is the cleanest read on that question.",
      bottomLine:
        "AMM Desk recorded its view before the result. Nine measurable claims below carry timestamps and will be scored against the actual filing and call on the morning of July 23 (AEST) — correct, incorrect, or partial. Nothing gets deleted.",
      keyStats: [
        "Report date: Tuesday July 22, after US market close (Wed 6:30am Brisbane)",
        "Five analysts: business quality · financial quality · industry · expectations · skeptic",
        "Claims recorded: 9 · Information cutoff: July 12, 2026",
        "First change report publishes the morning after results",
      ],
    },
    split: {
      vote: "3–2",
      question:
        "Is Alphabet's AI capex ramp value-accretive at its current pace?",
      majority:
        "Three seats hold that cloud revenue growth and margin trajectory justify the spend: AI capacity is demand-constrained, not speculative, and the quarter should show cloud growth holding above the high-20s with margins expanding.",
      dissent:
        "Two seats argue depreciation from the 2025–26 buildout is compounding faster than incremental AI revenue, and that this quarter's margin line — not the revenue line — will show the first visible strain. If capex guidance rises again without a matching cloud beat, the majority position weakens.",
      nextResolutionEvent:
        "Q2 2026 results and capex commentary on the July 22 call",
    },
    seats: [
      {
        seat: "Business quality",
        focus: "Search durability and YouTube in the AI era",
        position:
          "Watching whether Search revenue sustains double-digit growth despite AI-chat substitution narratives, and whether management quantifies AI Overviews/Gemini monetisation rather than gesturing at engagement.",
      },
      {
        seat: "Financial quality",
        focus: "Capex, depreciation, cash conversion",
        position:
          "The line to watch is depreciation growth versus cloud gross profit growth. Also tracking whether buybacks continue at recent scale alongside the capex ramp.",
      },
      {
        seat: "Industry",
        focus: "Cloud competitive position",
        position:
          "Reading Alphabet's cloud print as a leading indicator for the whole hyperscaler complex reporting the following week — relative growth versus Azure and AWS matters more than the absolute number.",
      },
      {
        seat: "Expectations",
        focus: "What the June selloff priced in",
        position:
          "After the June drawdown, the market enters this print with lowered AI-capex tolerance. The asymmetry: a modest cloud beat plus reaffirmed capex likely matters more than a headline EPS beat.",
      },
      {
        seat: "Red team",
        focus: "Thesis-breakers",
        position:
          "Hunting for the failure modes the majority ignores: capex ROI opacity, regulatory remedies still pending, and any change in how management words its AI-demand commentary versus prior calls — wording changes have led guidance changes before.",
      },
    ],
    claims: [
      { id: "googl-q2-01", claim: "Google Cloud revenue grows ≥ 28% year-over-year", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
      { id: "googl-q2-02", claim: "Google Cloud operating margin expands year-over-year", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
      { id: "googl-q2-03", claim: "Full-year 2026 capex guidance is raised or reaffirmed (not cut)", resolvesBy: "Jul 22 earnings call", status: "open" },
      { id: "googl-q2-04", claim: "Search & other revenue grows double-digits year-over-year", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
      { id: "googl-q2-05", claim: "YouTube advertising revenue grows ≥ 10% year-over-year", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
      { id: "googl-q2-06", claim: "Management cites AI capacity constraints on the call", resolvesBy: "Jul 22 earnings call", status: "open" },
      { id: "googl-q2-07", claim: "Updated Gemini usage metrics are disclosed", resolvesBy: "Jul 22 earnings call", status: "open" },
      { id: "googl-q2-08", claim: "Share repurchases in the quarter total ≥ US$15B", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
      { id: "googl-q2-09", claim: "Other Bets operating loss narrows year-over-year", resolvesBy: "Q2 2026 filing (Jul 22)", status: "open" },
    ],
  },
};

export function getCouncilPage(ticker: string): CouncilPage | null {
  return COUNCIL_PAGES[ticker.toUpperCase()] ?? null;
}
