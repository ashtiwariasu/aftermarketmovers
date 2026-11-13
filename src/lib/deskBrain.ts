import type { DeskMessage } from "./desk";
import { getCouncilPage } from "./council";
import { getTickerSnapshot } from "./ticker";
import {
  runCouncil,
  callLlmc3Council,
  chairLlmc3Result,
} from "./councilEngine";

/**
 * The Desk's reply engine — now running the real LLM Council machinery
 * (councilEngine.ts) over the shared OpenRouter gateway. Metering is
 * enforced by the API route; this module just thinks.
 */
export interface DeskContext {
  tickers: string[];
  firstName?: string;
  /** Stock room the question was asked in — grounds the run on this company. */
  ticker?: string;
}

async function buildContext(question: string, ctx: DeskContext): Promise<string> {
  const parts: string[] = [
    `The member watches: ${ctx.tickers.join(", ") || "no companies yet"}.`,
  ];
  if (ctx.ticker) {
    parts.push(
      `This question was asked in the ${ctx.ticker} room — answer about ${ctx.ticker} unless the member clearly asks otherwise.`
    );
  }

  // Live snapshots: room ticker first, then mentioned, then watched.
  const mentioned = ctx.tickers.filter((t) =>
    question.toUpperCase().includes(t)
  );
  const toFetch = [
    ...new Set(
      [ctx.ticker, ...mentioned, ...ctx.tickers].filter(
        (t): t is string => !!t
      )
    ),
  ].slice(0, 3);
  const snaps = await Promise.all(toFetch.map((t) => getTickerSnapshot(t)));
  for (const s of snaps) {
    if (!s) continue;
    parts.push(
      `${s.symbol} (${s.name}): last close $${s.price?.toFixed(2) ?? "?"}, day ${
        s.dayChangePercent?.toFixed(2) ?? "?"
      }%, after-hours ${s.afterHoursChangePercent?.toFixed(2) ?? "quiet"}%. ${
        s.nextEvent ? `Next event: ${s.nextEvent}.` : ""
      }`
    );
  }

  // Locked-claims case files, when relevant.
  for (const t of toFetch) {
    const cp = getCouncilPage(t);
    if (!cp) continue;
    parts.push(
      `${cp.ticker} case file (claims locked ${cp.asOf}, information cutoff applies): council split ${cp.split.vote} on "${cp.split.question}". Majority: ${cp.split.majority} Dissent: ${cp.split.dissent} Open claims: ${cp.claims
        .slice(0, 5)
        .map((c) => `${c.claim} (${c.status.replace("resolved_", "")})`)
        .join("; ")}.`
    );
  }

  parts.push(
    `Today's date: ${new Date().toISOString().slice(0, 10)}. Extended-hours data may be delayed; do not fabricate numbers beyond the context given.`
  );
  return parts.join("\n");
}

export async function generateReply(
  question: string,
  ctx: DeskContext
): Promise<DeskMessage> {
  const context = await buildContext(question, ctx);

  // The real machinery first: llmc3's two-stage council over the internal
  // bridge (V2 selector → independent answers → anonymous peer rankings),
  // chaired into the NightDesk card. Local protocol as fallback.
  const llmc3Raw = await callLlmc3Council(question, context);
  const result = llmc3Raw
    ? ((await chairLlmc3Result(question, context, llmc3Raw)) ??
      (await runCouncil(question, context)))
    : await runCouncil(question, context);

  if (result) {
    return {
      at: Date.now(),
      role: "desk",
      kind: "council",
      text: result.synthesis,
      data: JSON.stringify(result),
    };
  }

  // Engine unavailable — honest fallback, never fake.
  const mentioned = ctx.tickers.find((t) => question.toUpperCase().includes(t));
  const cp = mentioned ? getCouncilPage(mentioned) : null;
  let text =
    "AMM Desk is busy right now — your question is saved and ready for review.";
  if (cp) {
    text += ` Meanwhile the ${cp.ticker} case file holds the ${cp.claims.length} locked claims and the ${cp.split.vote} split — /stock/${cp.ticker.toLowerCase()}.`;
  }
  return { at: Date.now(), role: "desk", kind: "reply", text };
}
