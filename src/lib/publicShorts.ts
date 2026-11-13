import "server-only";

import { Firestore } from "@google-cloud/firestore";
import { getDossierHistory, getProfile } from "@/lib/companyStore";
import type { Dossier } from "@/lib/dossier";
import {
  isPublishablePublicDossier,
  plainResearchText,
} from "@/lib/publicResearch";

const PUBLICATION_COLLECTION = "short_publications";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ISO_DATE = /^20\d{2}-\d{2}-\d{2}$/;
const PUBLICATION_SCAN_LIMIT = 100;

let db: Firestore | null = null;
function firestore(): Firestore {
  if (!db) {
    db = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
    });
  }
  return db;
}

export interface ShortPublicationRecord {
  videoId?: string;
  ticker?: string;
  dossierDate?: string;
  dossierGeneratedAt?: number;
  status?: string;
  publishAt?: string;
  scheduledAt?: number;
  thesisTitle?: string;
  signalDirection?: "UP" | "DOWN";
  signalStrength?: "GENTLE" | "MODERATE" | "STRONG";
  horizonSessions?: { min?: number; max?: number };
  sourceBundleSha256?: string;
  sourceCitationIds?: string[];
  sourceCitations?: PublicShortSource[];
}

export interface PublicShortSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  authority: string;
  publishedDate: string;
}

export interface PublicShort {
  videoId: string;
  ticker: string;
  companyName: string;
  dossierDate: string;
  publishedAt: string;
  title: string;
  signal: string | null;
  horizon: string | null;
  thumbnailUrl: string;
  sources: PublicShortSource[];
}

function safePublicSources(value: unknown): PublicShortSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PublicShortSource[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<PublicShortSource>;
    if (
      typeof source.id !== "string" ||
      typeof source.title !== "string" ||
      typeof source.url !== "string" ||
      typeof source.publisher !== "string" ||
      typeof source.authority !== "string" ||
      typeof source.publishedDate !== "string"
    ) return [];
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol)) return [];
    } catch {
      return [];
    }
    return [{
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      authority: source.authority,
      publishedDate: source.publishedDate,
    }];
  });
}

/**
 * A valid publication receipt makes a Short eligible for verification. The
 * receipt's planned release time can lag reality when YouTube publishes early,
 * so public playback—not the local schedule—is the final release authority.
 */
export function releasedShortCandidate(
  value: ShortPublicationRecord,
): value is Required<
  Pick<ShortPublicationRecord, "videoId" | "ticker" | "dossierDate" | "publishAt">
> & ShortPublicationRecord {
  const publishAt = Date.parse(value.publishAt ?? "");
  return (
    VIDEO_ID.test(value.videoId ?? "") &&
    /^[A-Z]{1,6}$/.test(value.ticker ?? "") &&
    ISO_DATE.test(value.dossierDate ?? "") &&
    Number.isFinite(publishAt) &&
    ["scheduled", "published"].includes(value.status ?? "")
  );
}

async function youtubeTitle(videoId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return null;
    const value = (await response.json()) as { title?: string };
    return typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : null;
  } catch {
    return null;
  }
}

async function exactDossier(
  ticker: string,
  date: string,
  generatedAt?: number,
): Promise<Dossier | null> {
  const history = await getDossierHistory<Dossier>(ticker, 45).catch(() => []);
  return (
    history.find(
      (dossier) =>
        dossier.date === date &&
        (!generatedAt || dossier.generatedAt === generatedAt) &&
        isPublishablePublicDossier(dossier),
    ) ??
    history.find(
      (dossier) =>
        dossier.date === date && isPublishablePublicDossier(dossier),
    ) ??
    null
  );
}

/**
 * Firestore provides the immutable video/dossier binding. YouTube provides a
 * public-availability receipt. Private, deleted or failed uploads never render.
 */
async function findLatestPublicShorts({
  limit,
  ticker,
}: {
  limit: number;
  ticker?: string;
}): Promise<PublicShort[]> {
  const symbol = ticker?.trim().toUpperCase();
  const snapshot = await firestore()
    .collection(PUBLICATION_COLLECTION)
    .orderBy("scheduledAt", "desc")
    .limit(PUBLICATION_SCAN_LIMIT)
    .get()
    .catch(() => null);
  if (!snapshot) return [];

  const rows = snapshot.docs
    .map((document) => document.data() as ShortPublicationRecord)
    .filter((row) => releasedShortCandidate(row))
    .filter((row) => !symbol || row.ticker === symbol)
    .sort(
      (left, right) =>
        (right.scheduledAt ?? 0) - (left.scheduledAt ?? 0),
    );

  const result: PublicShort[] = [];
  for (const row of rows) {
    if (result.length >= Math.max(1, limit)) break;
    const title = await youtubeTitle(row.videoId!);
    if (!title) continue;

    const [dossier, profile] = await Promise.all([
      exactDossier(
        row.ticker!,
        row.dossierDate!,
        row.dossierGeneratedAt,
      ),
      getProfile(row.ticker!).catch(() => null),
    ]);
    const direction =
      row.signalDirection ?? dossier?.emailHook.signal.direction;
    const strength =
      row.signalStrength ?? dossier?.emailHook.signal.strength;
    const publicStrength =
      strength === "STRONG" ? "STRONG" : strength ? "GENTLE" : null;
    const horizon =
      row.horizonSessions ?? dossier?.emailHook.signal.horizonSessions;
    const thesisTitle =
      typeof row.thesisTitle === "string" && row.thesisTitle.trim()
        ? row.thesisTitle.trim()
        : dossier
          ? plainResearchText(dossier.emailHook.subjectPunchline)
          : title;
    let sources = safePublicSources(row.sourceCitations);
    // Compatibility for a publication written during the brief citation-ID
    // migration. IDs are safe only when the stored dossier is the exact
    // generation bound to the video; same-day replacements must never remap
    // them to different evidence.
    if (
      sources.length === 0 &&
      dossier &&
      dossier.generatedAt === row.dossierGeneratedAt &&
      Array.isArray(row.sourceCitationIds)
    ) {
      const citationById = new Map(
        (dossier.citations ?? []).map((citation) => [citation.id, citation]),
      );
      sources = row.sourceCitationIds.flatMap((citationId): PublicShortSource[] => {
        const citation = citationById.get(citationId);
        return citation
          ? [{
              id: citation.id,
              title: citation.title,
              url: citation.url,
              publisher: citation.publisher,
              authority: citation.authority,
              publishedDate: citation.publishedDate,
            }]
          : [];
      });
    }

    result.push({
      videoId: row.videoId!,
      ticker: row.ticker!,
      companyName: profile?.name?.trim() || row.ticker!,
      dossierDate: row.dossierDate!,
      publishedAt: row.publishAt!,
      title: thesisTitle,
      signal:
        direction && publicStrength
          ? `${publicStrength} ${direction === "UP" ? "UPSIDE" : "DOWNSIDE"}`
          : null,
      horizon: Number.isFinite(horizon?.min) && Number.isFinite(horizon?.max)
        ? `${horizon!.min}–${horizon!.max} SESSIONS`
        : null,
      thumbnailUrl: `https://i.ytimg.com/vi/${row.videoId}/oar2.jpg`,
      sources,
    });
  }
  return result;
}

export async function getLatestPublicShorts(limit = 2): Promise<PublicShort[]> {
  return findLatestPublicShorts({ limit });
}

export async function getLatestPublicShortForTicker(
  ticker: string,
): Promise<PublicShort | null> {
  return (await findLatestPublicShorts({ limit: 1, ticker }))[0] ?? null;
}
