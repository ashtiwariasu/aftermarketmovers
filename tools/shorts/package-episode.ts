#!/usr/bin/env tsx
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  buildShortEpisodePackage,
  type ShortEpisodeDraft,
} from "../../src/lib/shortEpisode";
import type { Dossier } from "../../src/lib/dossier";
import { getLatestPublishableDossier } from "../../src/lib/publicResearch";

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function loadDossier(): Promise<Dossier> {
  const dossierPath = valueAfter("--dossier");
  if (dossierPath) return JSON.parse(await readFile(dossierPath, "utf8")) as Dossier;
  const ticker = valueAfter("--ticker")?.toUpperCase();
  if (!ticker) throw new Error("provide --ticker META or --dossier path/to/dossier.json");
  const dossier = await getLatestPublishableDossier(ticker);
  if (!dossier) throw new Error(`no publishable dossier found for ${ticker}`);
  return dossier;
}

async function main(): Promise<void> {
  const draftPath = valueAfter("--draft");
  if (!draftPath) throw new Error("provide --draft path/to/draft.json");
  const dossier = await loadDossier();
  const draft = JSON.parse(await readFile(draftPath, "utf8")) as ShortEpisodeDraft;
  const episode = buildShortEpisodePackage(dossier, draft);
  const output = valueAfter("--out") ??
    path.join("tools", "shorts", "out", `${dossier.ticker}-${dossier.date}`, "episode-package.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(episode, null, 2)}\n`);
  await writeFile(
    path.join(path.dirname(output), "dossier.json"),
    `${JSON.stringify(dossier, null, 2)}\n`,
  );
  await writeFile(
    path.join(path.dirname(output), "source-description.txt"),
    `${episode.publication.sourceDescription}\n\nTrace: ${episode.publication.traceUrl}\n`,
  );
  console.log(JSON.stringify({
    output,
    episodeId: episode.episodeId,
    words: episode.editorial.words,
    estimatedSeconds: episode.editorial.estimatedSeconds,
    dossier: episode.dossier.artifactKey,
    dossierSnapshot: path.join(path.dirname(output), "dossier.json"),
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
