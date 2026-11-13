import { Firestore } from "@google-cloud/firestore";
// Founding record entry: GOOGL 2/5, oracle = Q2 2026 earnings Jul 22.
async function main() {
  const db = new Firestore();
  const id = "GOOGL:2026-07-16";
  await db.collection("activeQuestions").doc(id).set({
    id, ticker: "GOOGL",
    question: "Is the 81% profit jump real and repeatable?",
    thesis: "If the filed +81% profit jump reflects durable operations, rare strength; if one-off items or corrupted-label comparisons, the file's strongest fact collapses while the EU mandate stands.",
    votesYes: 2, votesTotal: 5,
    publishedAt: 1784244000000, publishedDate: "2026-07-16",
    oracle: { type: "filing", trigger: "Q2 2026 earnings — Jul 22 after close", dueBy: "2026-07-24" },
    status: "open", priceAtPublish: 354.46,
  }, { merge: true });
  console.log("founding question seeded:", id);
}
main();
