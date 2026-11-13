import type {
  DailyShortAudienceSignal,
  DailyShortPublicationHistory,
} from "@/lib/dailyShorts";

export interface StoredShortAudienceRecord {
  id?: string;
  ticker?: string;
  publicationDate?: string;
  publishAt?: string;
  status?: string;
  videoId?: string;
  scheduledAt?: number;
  youtubeMetrics?: {
    views?: number;
    engagedViews?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    averageViewPercentage?: number;
    subscribersGained?: number;
    capturedAt?: number;
  };
  conversionMetrics?: {
    dossierVisits?: number;
    trialStarts?: number;
  };
}

export interface DailyShortAudienceContext {
  audienceSignals: Map<string, DailyShortAudienceSignal>;
  publicationHistory: DailyShortPublicationHistory[];
}

interface RawTickerAudience {
  ticker: string;
  currentInterest: number | null;
  historicalEngagement: number | null;
  demandAcceleration: number | null;
  conversionIntent: number | null;
  sampleSize: number;
  measuredAt?: number;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalized(values: Map<string, number | null>, ticker: string): number {
  const available = [...values.values()].filter((value): value is number => value !== null);
  const value = values.get(ticker) ?? null;
  if (value === null || !available.length) return 50;
  const minimum = Math.min(...available);
  const maximum = Math.max(...available);
  if (maximum === minimum) return 50;
  return Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100));
}

function dateAgeDays(date: string, targetDate: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${targetDate}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) /
      86_400_000,
    ),
  );
}

function engagementQuality(record: StoredShortAudienceRecord): number | null {
  const metrics = record.youtubeMetrics;
  if (!metrics) return null;
  const averageViewed = finite(metrics.averageViewPercentage);
  if (averageViewed !== null) return Math.min(100, averageViewed);
  const views = finite(metrics.engagedViews) ?? finite(metrics.views);
  if (!views || views <= 0) return null;
  const likes = finite(metrics.likes) ?? 0;
  const comments = finite(metrics.comments) ?? 0;
  const shares = finite(metrics.shares) ?? 0;
  const subscribers = finite(metrics.subscribersGained) ?? 0;
  return Math.min(
    100,
    ((likes + comments * 2 + shares * 3 + subscribers * 5) / views) * 1_000,
  );
}

function conversionQuality(record: StoredShortAudienceRecord): number | null {
  const conversions = record.conversionMetrics;
  if (!conversions) return null;
  const views = finite(record.youtubeMetrics?.engagedViews) ??
    finite(record.youtubeMetrics?.views);
  if (!views || views <= 0) return null;
  const visits = finite(conversions.dossierVisits) ?? 0;
  const trials = finite(conversions.trialStarts) ?? 0;
  return ((visits + trials * 10) / views) * 1_000;
}

/**
 * Converts stored, audited publication receipts into deterministic ranking
 * inputs. Missing metrics stay neutral; publication history is still retained
 * for fatigue protection.
 */
export function buildDailyShortAudienceContext(
  records: readonly StoredShortAudienceRecord[],
  targetDate: string,
): DailyShortAudienceContext {
  const handled = records.filter((record) => {
    const ticker = record.ticker?.trim();
    const date = (record.publicationDate ?? record.publishAt?.slice(0, 10))?.trim();
    const status = record.status?.trim();
    return Boolean(
      ticker &&
      date &&
      /^20\d{2}-\d{2}-\d{2}$/.test(date) &&
      (status === "scheduled" || status === "published"),
    );
  });
  const publicationHistory = handled.map((record) => ({
    ticker: record.ticker!.toUpperCase(),
    publicationDate: (record.publicationDate ?? record.publishAt!.slice(0, 10))!,
  }));
  const grouped = new Map<string, StoredShortAudienceRecord[]>();
  for (const record of handled) {
    const ticker = record.ticker!.toUpperCase();
    grouped.set(ticker, [...(grouped.get(ticker) ?? []), record]);
  }

  const raw = new Map<string, RawTickerAudience>();
  for (const [ticker, tickerRecords] of grouped) {
    const measured = tickerRecords.filter((record) => {
      const metrics = record.youtubeMetrics;
      return Boolean(metrics && (
        finite(metrics.views) !== null ||
        finite(metrics.engagedViews) !== null ||
        finite(metrics.averageViewPercentage) !== null
      ));
    });
    const publicationDate = (record: StoredShortAudienceRecord) =>
      (record.publicationDate ?? record.publishAt?.slice(0, 10))!;
    const recent = measured.filter((record) =>
      dateAgeDays(publicationDate(record), targetDate) <= 28);
    const earlier = measured.filter((record) =>
      dateAgeDays(publicationDate(record), targetDate) > 28);
    const demand = (record: StoredShortAudienceRecord) =>
      finite(record.youtubeMetrics?.engagedViews) ??
      finite(record.youtubeMetrics?.views);
    const recentDemand = mean(recent.flatMap((record) => {
      const value = demand(record);
      return value === null ? [] : [Math.log1p(value)];
    }));
    const earlierDemand = mean(earlier.flatMap((record) => {
      const value = demand(record);
      return value === null ? [] : [Math.log1p(value)];
    }));
    const acceleration = recentDemand === null
      ? null
      : earlierDemand === null
        ? 50
        : Math.max(0, Math.min(100, 50 + (recentDemand - earlierDemand) * 20));
    raw.set(ticker, {
      ticker,
      currentInterest: recentDemand,
      historicalEngagement: mean(measured.flatMap((record) => {
        const value = engagementQuality(record);
        return value === null ? [] : [value];
      })),
      demandAcceleration: acceleration,
      conversionIntent: mean(measured.flatMap((record) => {
        const value = conversionQuality(record);
        return value === null ? [] : [value];
      })),
      sampleSize: measured.length,
      measuredAt: Math.max(
        0,
        ...measured.map((record) => finite(record.youtubeMetrics?.capturedAt) ?? 0),
      ) || undefined,
    });
  }

  const currentInterestValues = new Map(
    [...raw].map(([ticker, value]) => [ticker, value.currentInterest]),
  );
  const engagementValues = new Map(
    [...raw].map(([ticker, value]) => [ticker, value.historicalEngagement]),
  );
  const conversionValues = new Map(
    [...raw].map(([ticker, value]) => [ticker, value.conversionIntent]),
  );
  const audienceSignals = new Map<string, DailyShortAudienceSignal>();
  for (const [ticker, value] of raw) {
    audienceSignals.set(ticker, {
      ticker,
      currentInterest: normalized(currentInterestValues, ticker),
      historicalEngagement: normalized(engagementValues, ticker),
      demandAcceleration: value.demandAcceleration ?? 50,
      conversionIntent: normalized(conversionValues, ticker),
      sampleSize: value.sampleSize,
      measuredAt: value.measuredAt,
    });
  }
  return { audienceSignals, publicationHistory };
}
