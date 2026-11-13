import type { MetadataRoute } from "next";
import { connection } from "next/server";
import {
  getLatestPublishableDossier,
  PUBLIC_RESEARCH_TICKERS,
} from "@/lib/publicResearch";
import { isPublicProductionBuild } from "@/lib/environment";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isPublicProductionBuild()) await connection();
  const base = "https://aftermarketmovers.com";
  const tickerResearch = await Promise.all(
    PUBLIC_RESEARCH_TICKERS.map(async (ticker) => ({
      ticker,
      dossier: await getLatestPublishableDossier(ticker),
    })),
  );
  const newestResearchAt = tickerResearch.reduce(
    (latest, item) => Math.max(latest, item.dossier?.generatedAt ?? 0),
    0,
  );

  return [
    {
      url: `${base}/`,
      ...(newestResearchAt ? { lastModified: new Date(newestResearchAt) } : {}),
      changeFrequency: "daily",
      priority: 1,
    },
    ...tickerResearch.filter((item) => item.dossier !== null).map(({ ticker, dossier }) => ({
      url: `${base}/stock/${ticker.toLowerCase()}`,
      ...(dossier ? { lastModified: new Date(dossier.generatedAt) } : {}),
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
    { url: `${base}/pricing`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/methodology`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/team`, changeFrequency: "monthly", priority: 0.7 },
  ];
}
