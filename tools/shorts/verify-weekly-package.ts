#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import type { Dossier } from "../../src/lib/dossier";
import {
  weeklyShortPackageValidationError,
  type WeeklyShortEpisodePackage,
} from "../../src/lib/weeklyShortEpisode";

async function main(): Promise<void> {
  const [packagePath, dossiersPath, verifierPath] = process.argv.slice(2);
  if (!packagePath || !dossiersPath || !verifierPath) {
    throw new Error(
      "usage: verify-weekly-package.ts episode-package.json dossiers.json verifier-receipt.json",
    );
  }
  const [episode, dossiers, verifier] = await Promise.all([
    readFile(packagePath, "utf8").then(
      (value) => JSON.parse(value) as WeeklyShortEpisodePackage,
    ),
    readFile(dossiersPath, "utf8").then((value) => JSON.parse(value) as Dossier[]),
    readFile(verifierPath, "utf8").then((value) => JSON.parse(value) as {
      schema?: string;
      pass?: boolean;
      issues?: string[];
    }),
  ]);
  const error = weeklyShortPackageValidationError(dossiers, episode);
  if (error) throw new Error(`weekly package failed binding: ${error}`);
  if (
    verifier.schema !== "amm-weekly-short-verifier-receipt-v1" ||
    verifier.pass !== true ||
    (verifier.issues?.length ?? 0) > 0
  ) {
    throw new Error("weekly package has no passing independent verifier receipt");
  }
  console.log(JSON.stringify({
    status: "pass",
    episodeId: episode.episodeId,
    tickers: episode.stocks.map((stock) => stock.ticker),
    words: episode.editorial.words,
    sourceBundleSha256: episode.provenance.sourceBundleSha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
