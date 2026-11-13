/**
 * Audit every active desk against the exact research-support policy.
 *
 * Dry run:  GOOGLE_CLOUD_PROJECT=... npx tsx scripts/audit-stock-support.ts
 * Execute:  GOOGLE_CLOUD_PROJECT=... npx tsx scripts/audit-stock-support.ts --execute --confirm=us-research-v1
 *
 * Execute removes unsupported symbols only from active desk research. It does
 * not delete company files, dossiers, source records, signals, or outcomes.
 */
import { FieldPath, FieldValue, Firestore } from "@google-cloud/firestore";
import {
  assessResearchSupport,
  RESEARCH_SUPPORT_POLICY_VERSION,
  type ResearchSupportDecision,
} from "../src/lib/researchSupport";
import type { Desk } from "../src/lib/desk";

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required");
const execute = process.argv.includes("--execute");
const confirmation = process.argv.find((value) => value.startsWith("--confirm="))?.slice(10);
if (execute && confirmation !== RESEARCH_SUPPORT_POLICY_VERSION) {
  throw new Error(`execute requires --confirm=${RESEARCH_SUPPORT_POLICY_VERSION}`);
}

const db = new Firestore({ projectId });

async function listDesks(): Promise<Array<{ id: string; data: Desk }>> {
  const records: Array<{ id: string; data: Desk }> = [];
  let afterId: string | null = null;
  for (;;) {
    let query = db.collection("desks").orderBy(FieldPath.documentId()).limit(250);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.get();
    records.push(...page.docs.map((document) => ({ id: document.id, data: document.data() as Desk })));
    if (page.size < 250) break;
    afterId = page.docs.at(-1)?.id ?? null;
    if (!afterId) throw new Error("desk pagination lost its cursor");
  }
  return records;
}

async function main(): Promise<void> {
  const desks = await listDesks();
  const symbols = [...new Set(desks.flatMap((desk) => desk.data.tickers).map((ticker) => ticker.toUpperCase()))].sort();
  const decisions = new Map<string, ResearchSupportDecision>();
  for (const symbol of symbols) decisions.set(symbol, await assessResearchSupport(symbol));

  const unavailable = [...decisions.values()].filter((item) => item.code === "verification_unavailable");
  if (unavailable.length > 0) {
    throw new Error(`coverage verification unavailable: ${unavailable.map((item) => item.symbol).join(", ")}`);
  }

  const changes = desks.flatMap(({ id, data }) => {
    const excluded = data.tickers
      .map((ticker) => decisions.get(ticker.toUpperCase()))
      .filter((item): item is ResearchSupportDecision => Boolean(item && !item.supported));
    if (excluded.length === 0) return [];
    return [{
      deskId: id,
      before: data.tickers,
      after: data.tickers.filter((ticker) => decisions.get(ticker.toUpperCase())?.supported),
      excluded,
    }];
  });

  if (execute) {
    for (const change of changes) {
      const deskRef = db.collection("desks").doc(change.deskId);
      const auditRef = db.collection("stock_support_audits")
        .doc(`${RESEARCH_SUPPORT_POLICY_VERSION}-${change.deskId}`);
      await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(deskRef);
        if (!currentSnapshot.exists) return;
        const current = currentSnapshot.data() as Desk;
        const unknown = current.tickers.filter((ticker) => !decisions.has(ticker.toUpperCase()));
        if (unknown.length > 0) {
          throw new Error(`${change.deskId}: ticker set changed during audit (${unknown.join(", ")})`);
        }
        const currentExcluded = current.tickers
          .map((ticker) => decisions.get(ticker.toUpperCase()))
          .filter((item): item is ResearchSupportDecision => Boolean(item && !item.supported));
        if (currentExcluded.length === 0) return;
        const pausedAt = Date.now();
        const supportPaused = { ...(current.supportPaused ?? {}) };
        for (const item of currentExcluded) {
          supportPaused[item.symbol] = {
            code: item.code,
            message: item.message,
            policyVersion: item.policyVersion,
            pausedAt,
          };
        }
        const after = current.tickers.filter((ticker) => decisions.get(ticker.toUpperCase())?.supported);
        transaction.update(deskRef, {
          tickers: after,
          supportPaused,
          activity: FieldValue.arrayUnion(...currentExcluded.map((item) => ({
            at: pausedAt,
            text: `${item.symbol} paused — outside AMM's verified US-company research coverage`,
          }))),
        });
        transaction.set(auditRef, {
          policyVersion: RESEARCH_SUPPORT_POLICY_VERSION,
          deskId: change.deskId,
          before: current.tickers,
          after,
          excluded: currentExcluded,
          appliedAt: pausedAt,
        });
      });
    }
  }

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    policyVersion: RESEARCH_SUPPORT_POLICY_VERSION,
    desks: desks.length,
    symbols: symbols.length,
    supported: [...decisions.values()].filter((item) => item.supported).map((item) => item.symbol),
    excluded: [...decisions.values()].filter((item) => !item.supported).map((item) => ({
      symbol: item.symbol,
      code: item.code,
      message: item.message,
    })),
    changes: changes.map((change) => ({
      deskId: change.deskId,
      before: change.before,
      after: change.after,
      excluded: change.excluded.map((item) => item.symbol),
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
