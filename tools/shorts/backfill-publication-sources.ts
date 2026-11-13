#!/usr/bin/env tsx
/**
 * Add the exact citation-ID receipt from a validated episode package to its
 * existing publication record. Dry-run is the default; --apply is explicit.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Firestore } from "@google-cloud/firestore";
import {
  SHORT_EPISODE_SCHEMA,
  shortEpisodeUsedCitationIds,
  shortEpisodeUsedCitations,
  type ShortEpisodePackage,
} from "../../src/lib/shortEpisode";

async function main(): Promise<void> {
  const packagePath = process.argv[2];
  const apply = process.argv.includes("--apply");
  const expectedVideoIndex = process.argv.indexOf("--expected-video-id");
  const expectedVideoId =
    expectedVideoIndex >= 0 ? process.argv[expectedVideoIndex + 1] : null;

  if (!packagePath) {
    throw new Error(
      "usage: backfill-publication-sources.ts episode-package.json " +
        "[--expected-video-id VIDEO_ID] [--apply]",
    );
  }

  const episode = JSON.parse(
    await readFile(packagePath, "utf8"),
  ) as ShortEpisodePackage;
  if (episode.schema !== SHORT_EPISODE_SCHEMA) {
    throw new Error(`expected ${SHORT_EPISODE_SCHEMA}`);
  }

  const publicationId = createHash("sha256")
    .update(episode.dossier.artifactKey)
    .digest("hex")
    .slice(0, 48);
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
  });
  const ref = db.collection("short_publications").doc(publicationId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error(`publication ${publicationId} not found`);

  const publication = snapshot.data() as {
    artifactKey?: string;
    ticker?: string;
    dossierDate?: string;
    videoId?: string;
    status?: string;
  };
  if (
    publication.artifactKey !== episode.dossier.artifactKey ||
    publication.ticker !== episode.dossier.ticker ||
    publication.dossierDate !== episode.dossier.date
  ) {
    throw new Error("publication does not match the immutable episode dossier");
  }
  if (expectedVideoId && publication.videoId !== expectedVideoId) {
    throw new Error(
      `publication video ${publication.videoId ?? "missing"} does not match ${expectedVideoId}`,
    );
  }
  if (!["scheduled", "published"].includes(publication.status ?? "")) {
    throw new Error(`publication is not released: ${publication.status ?? "unknown"}`);
  }

  const sourceCitationIds = shortEpisodeUsedCitationIds(episode);
  if (!sourceCitationIds.length) {
    throw new Error("episode has no used citations");
  }
  const patch = {
    episodeId: episode.episodeId,
    sourceBundleSha256: episode.provenance.sourceBundleSha256,
    sourceCitationIds,
    sourceCitations: shortEpisodeUsedCitations(episode),
    sourceReceiptBackfilledAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (apply) await ref.set(patch, { merge: true });
  console.log(JSON.stringify({
    mode: apply ? "applied" : "dry-run",
    publicationId,
    ticker: publication.ticker,
    videoId: publication.videoId,
    sourceCitationIds,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
