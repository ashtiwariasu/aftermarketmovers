/** Fail a release before a v3 worker encounters an older private record. */
import { FieldPath, Firestore } from "@google-cloud/firestore";
import { PRIVATE_SIGNAL_SCHEMA_VERSION } from "../src/lib/privateSignalResearch";

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
if (!projectId) {
  throw new Error(
    "GOOGLE_CLOUD_PROJECT is required; refusing to validate an ambient or accidental Firestore project",
  );
}

async function main(): Promise<void> {
  const db = new Firestore({ projectId });
  const collection = db.collection("private_signal_research");
  let afterId: string | null = null;
  let checked = 0;
  const incompatible: Array<{ id: string; version: unknown }> = [];
  for (;;) {
    let query = collection.orderBy(FieldPath.documentId()).limit(500);
    if (afterId) query = query.startAfter(afterId);
    const page = await query.select("schemaVersion").get();
    for (const document of page.docs) {
      checked += 1;
      const version = document.get("schemaVersion") as unknown;
      if (version !== PRIVATE_SIGNAL_SCHEMA_VERSION) {
        incompatible.push({ id: document.id, version });
      }
    }
    if (page.size < 500) break;
    afterId = page.docs.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  console.log(JSON.stringify({
    projectId,
    expectedSchemaVersion: PRIVATE_SIGNAL_SCHEMA_VERSION,
    checked,
    incompatible: incompatible.slice(0, 50),
    incompatibleCount: incompatible.length,
  }, null, 2));
  if (incompatible.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
