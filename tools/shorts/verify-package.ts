#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import type { Dossier } from "../../src/lib/dossier";
import {
  shortPackageValidationError,
  type ShortEpisodePackage,
} from "../../src/lib/shortEpisode";

const [packagePath, dossierPath] = process.argv.slice(2);
if (!packagePath || !dossierPath) {
  console.error("usage: verify-package.ts episode-package.json dossier.json");
  process.exit(2);
}

async function main(): Promise<void> {
  const episode = JSON.parse(await readFile(packagePath, "utf8")) as ShortEpisodePackage;
  const dossier = JSON.parse(await readFile(dossierPath, "utf8")) as Dossier;
  const error = shortPackageValidationError(dossier, episode);
  if (error) throw new Error(`BLOCKED: ${error}`);
  console.log(JSON.stringify({
    valid: true,
    episodeId: episode.episodeId,
    dossier: episode.dossier.artifactKey,
    words: episode.editorial.words,
    estimatedSeconds: episode.editorial.estimatedSeconds,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
