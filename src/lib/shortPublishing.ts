import { readFile } from "node:fs/promises";
import type { ShortEpisodePackage } from "@/lib/shortEpisode";
import type { WeeklyShortEpisodePackage } from "@/lib/weeklyShortEpisode";

export const YOUTUBE_SHORT_CATEGORY_ID = "28"; // Science & Technology
export const YOUTUBE_PUBLICATION_SLOTS = [
  { hour: 8, minute: 30 },
  { hour: 8, minute: 45 },
] as const;
export const YOUTUBE_WEEKEND_RECAP_SLOT = { hour: 9, minute: 0 } as const;

export interface YouTubeOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface YouTubeShortMetadata {
  snippet: {
    title: string;
    description: string;
    categoryId: typeof YOUTUBE_SHORT_CATEGORY_ID;
    tags: string[];
    defaultLanguage: "en";
    defaultAudioLanguage: "en";
  };
  status: {
    privacyStatus: "private" | "public";
    publishAt?: string;
    selfDeclaredMadeForKids: false;
    containsSyntheticMedia: true;
    embeddable: true;
    publicStatsViewable: true;
    license: "youtube";
  };
}

interface YouTubeVideoResource {
  id: string;
  snippet?: { title?: string; description?: string };
  status?: { privacyStatus?: string; publishAt?: string };
}

export interface YouTubeShortAudienceMetrics {
  videoId: string;
  views?: number;
  engagedViews?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  averageViewPercentage?: number;
  subscribersGained?: number;
  capturedAt: number;
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

/**
 * Convert a wall-clock time in an IANA timezone to an instant without adding a
 * date library. Two passes handle DST offsets around the requested date.
 */
export function zonedDateTimeToUtc(input: {
  date: string;
  hour: number;
  minute: number;
  timeZone?: string;
}): Date {
  const timeZone = input.timeZone ?? "America/New_York";
  const [year, month, day] = input.date.split("-").map(Number);
  const intendedUtc = Date.UTC(year, month - 1, day, input.hour, input.minute, 0);
  let guess = intendedUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const renderedAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    guess += intendedUtc - renderedAsUtc;
  }
  return new Date(guess);
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 12)).toISOString().slice(0, 10);
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  targetWeekday: number,
  occurrence: number,
): string {
  const firstWeekday = weekday(year, month, 1);
  const day = 1 + ((targetWeekday - firstWeekday + 7) % 7) + (occurrence - 1) * 7;
  return isoDate(year, month, day);
}

function lastWeekdayOfMonth(year: number, month: number, targetWeekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  const lastWeekday = weekday(year, month, lastDay);
  return isoDate(year, month, lastDay - ((lastWeekday - targetWeekday + 7) % 7));
}

/** Anonymous Gregorian computus; NYSE closes on the Friday before Easter. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const value = isoDate(year, month, day);
  const dayOfWeek = weekday(year, month, day);
  if (dayOfWeek === 6) return addUtcDays(value, -1);
  if (dayOfWeek === 0) return addUtcDays(value, 1);
  return value;
}

/**
 * Full-day US equity-market closures from the NYSE published calendar.
 * Early-close sessions remain valid publication days because both Shorts land
 * before the 09:30 ET core open. Unscheduled emergency closures can be added
 * to this explicit set without changing the recurring rules.
 *
 * https://www.nyse.com/trade/hours-calendars
 */
function nyseFullDayClosures(year: number): Set<string> {
  const easter = easterSunday(year);
  const closures = new Set<string>([
    // NYSE does not observe New Year's Day on the preceding Friday when Jan 1
    // falls on Saturday. A Sunday New Year is observed on Monday.
    weekday(year, 1, 1) === 6
      ? isoDate(year, 1, 1)
      : observedFixedHoliday(year, 1, 1),
    nthWeekdayOfMonth(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekdayOfMonth(year, 2, 1, 3), // Washington's Birthday
    addUtcDays(easter, -2), // Good Friday
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day
    observedFixedHoliday(year, 7, 4), // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving
    observedFixedHoliday(year, 12, 25), // Christmas
  ]);
  // Juneteenth became an NYSE holiday in 2022.
  if (year >= 2022) closures.add(observedFixedHoliday(year, 6, 19));
  return closures;
}

export function isUsEquityTradingDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date) return false;
  const day = value.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !nyseFullDayClosures(value.getUTCFullYear()).has(date);
}

export function previousUsEquityTradingDay(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid ISO date");
  let candidate = addUtcDays(date, -1);
  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (isUsEquityTradingDay(candidate)) return candidate;
    candidate = addUtcDays(candidate, -1);
  }
  throw new Error(`could not find previous US equity trading day before ${date}`);
}

export function plannedPublicationSlots(input: {
  publicationDate: string;
  count: number;
}): Date[] {
  if (!Number.isInteger(input.count) || input.count < 0 || input.count > YOUTUBE_PUBLICATION_SLOTS.length) {
    throw new Error("invalid YouTube publication slot count");
  }
  if (input.count === 0) return [];
  if (!isUsEquityTradingDay(input.publicationDate)) {
    throw new Error(`YouTube Shorts publish only on US equity trading days: ${input.publicationDate}`);
  }
  return YOUTUBE_PUBLICATION_SLOTS
    .slice(0, input.count)
    .map((slot) => zonedDateTimeToUtc({ date: input.publicationDate, ...slot }));
}

export function publicationSlots(input: {
  publicationDate: string;
  count: number;
  now?: Date;
  minimumLeadMinutes?: number;
}): Date[] {
  const candidates = plannedPublicationSlots(input);
  if (candidates.length === 0) return [];
  const now = input.now ?? new Date();
  const earliest = now.getTime() + (input.minimumLeadMinutes ?? 20) * 60_000;
  if (candidates.some((candidate) => candidate.getTime() < earliest)) {
    throw new Error(
      `same-day YouTube pre-market window missed for ${input.publicationDate}; stale rollover is forbidden`,
    );
  }
  return candidates;
}

export function weekendRecapPublicationSlot(input: {
  publicationDate: string;
  now?: Date;
  minimumLeadMinutes?: number;
}): Date {
  if (isUsEquityTradingDay(input.publicationDate)) {
    throw new Error(`weekend recap publishes only on a non-trading day: ${input.publicationDate}`);
  }
  const slot = zonedDateTimeToUtc({
    date: input.publicationDate,
    ...YOUTUBE_WEEKEND_RECAP_SLOT,
  });
  const earliest = (input.now ?? new Date()).getTime() +
    (input.minimumLeadMinutes ?? 20) * 60_000;
  if (slot.getTime() < earliest) {
    throw new Error(
      `same-day YouTube weekend recap window missed for ${input.publicationDate}; stale rollover is forbidden`,
    );
  }
  return slot;
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function buildYouTubeShortMetadata(
  episode: ShortEpisodePackage,
  publishAt: Date,
  options: { publishImmediately?: boolean } = {},
): YouTubeShortMetadata {
  const support = episode.signal.votes.support;
  const title = episode.format === "weekend-recap"
    ? `${episode.dossier.ticker} Weekend Recap: ${titleCase(episode.signal.label)} — ` +
      `${support}/5 AI Analysts | AMM`
    : `${episode.dossier.ticker}: ${titleCase(episode.signal.label)} — ` +
      `What ${support}/5 AI Analysts Found | AMM`;
  const sourceDescription = episode.publication.sourceDescription.trim();
  const lead = episode.format === "weekend-recap"
    ? `${episode.dossier.ticker} · WEEKEND RECAP · ${episode.signal.label} · ` +
      `${episode.reportingCycle?.startLabel ?? "LAST RESULTS"} → ` +
      `${episode.reportingCycle?.endLabel ?? "NEXT RESULTS"}`
    : `${episode.dossier.ticker} · ${episode.signal.label} · ` +
      `${episode.signal.horizonSessions.min}–${episode.signal.horizonSessions.max} trading sessions`;
  const description = [
    lead,
    `AMM-EPISODE-ID: ${episode.episodeId}`,
    "",
    `Council: ${support} support · ${episode.signal.votes.oppose} oppose · ` +
      `${episode.signal.votes.uncertain} uncertain`,
    "",
    sourceDescription.slice(0, 3_400),
    "",
    `Full dossier: ${episode.publication.traceUrl}`,
    "",
    "This video uses an AI-generated presenter and the creator's synthetic voice. " +
      "The research, claims and sources are independently audited before publication.",
    "",
    "Independent factual market research. Not financial, investment, tax or legal advice.",
    "#stocks #investing #AIresearch #Shorts",
  ].join("\n");
  return {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5_000),
      categoryId: YOUTUBE_SHORT_CATEGORY_ID,
      tags: [
        episode.dossier.ticker,
        `${episode.dossier.ticker} stock`,
        "stock research",
        "AI stock research",
        "AMM",
      ],
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: options.publishImmediately ? "public" : "private",
      ...(!options.publishImmediately ? { publishAt: publishAt.toISOString() } : {}),
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
  };
}

export function buildYouTubeWeeklyShortMetadata(
  episode: WeeklyShortEpisodePackage,
  publishAt: Date,
): YouTubeShortMetadata {
  const count = episode.stocks.length;
  const title = episode.edition === "weekly-review"
    ? `${count} Stock Theses That Matter This Week | AMM`
    : `${count} Stock Theses to Watch Next Week | AMM`;
  const stockLines = episode.stocks.map((stock) =>
    `${stock.ticker} · ${stock.signal.strength} ` +
    `${stock.signal.direction === "UP" ? "UPSIDE" : "DOWNSIDE"} · ` +
    `${stock.lifecycleStatus.toUpperCase()} · ` +
    `${stock.votes.support}/5 agree`);
  const sources = episode.provenance.citations
    .slice(0, 24)
    .map((citation) =>
      `${citation.id} · ${citation.publisher} · ${citation.publishedDate} · ${citation.url}`);
  const description = [
    episode.edition === "weekly-review"
      ? "AMM WEEKLY REVIEW · STANDING THESIS MOVEMENT"
      : "AMM WEEK AHEAD · STANDING THESIS MOVEMENT",
    `AMM-EPISODE-ID: ${episode.episodeId}`,
    "",
    ...stockLines,
    "",
    "Every spoken claim is bound to the frozen AMM dossiers and source excerpts used for this episode.",
    `Research the companies: https://aftermarketmovers.com/?utm_source=youtube&utm_medium=shorts&utm_campaign=${episode.edition}`,
    "",
    "Sources used:",
    ...sources,
    "",
    "This video uses an AI-generated presenter and the creator's synthetic voice. " +
      "The research, claims and sources are independently audited before publication.",
    "",
    "Independent factual market research. Not financial, investment, tax or legal advice.",
    "#stocks #investing #stockmarket #AIresearch #Shorts",
  ].join("\n");
  return {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5_000),
      categoryId: YOUTUBE_SHORT_CATEGORY_ID,
      tags: [
        ...episode.stocks.map((stock) => stock.ticker),
        "weekly stock review",
        "stock market news",
        "AI stock research",
        "AMM",
      ],
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: "private",
      publishAt: publishAt.toISOString(),
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
  };
}

async function youtubeAccessToken(credentials: YouTubeOAuthCredentials): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(`YouTube OAuth refresh failed: ${payload.error_description ?? response.status}`);
  }
  return payload.access_token;
}

async function youtubeJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`YouTube API ${response.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

function optionalCount(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Best-effort audience receipt refresh. Public video statistics work with the
 * existing YouTube read scope. Shorts-specific retention fields require the
 * YouTube Analytics read scope; when that grant is absent the richer fields
 * remain undefined instead of blocking research or publication.
 */
export async function fetchYouTubeShortAudienceMetrics(input: {
  credentials: YouTubeOAuthCredentials;
  videoIds: string[];
  startDate?: string;
  endDate?: string;
}): Promise<Map<string, YouTubeShortAudienceMetrics>> {
  const ids = [...new Set(input.videoIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  const output = new Map<string, YouTubeShortAudienceMetrics>();
  if (!ids.length) return output;
  const token = await youtubeAccessToken(input.credentials);
  const capturedAt = Date.now();
  const statistics = await youtubeJson<{
    items?: Array<{
      id?: string;
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
    }>;
  }>(
    "https://www.googleapis.com/youtube/v3/videos?" +
      new URLSearchParams({ part: "statistics", id: ids.join(",") }),
    token,
  );
  for (const item of statistics.items ?? []) {
    if (!item.id) continue;
    output.set(item.id, {
      videoId: item.id,
      views: optionalCount(item.statistics?.viewCount),
      likes: optionalCount(item.statistics?.likeCount),
      comments: optionalCount(item.statistics?.commentCount),
      capturedAt,
    });
  }

  const endDate = input.endDate ?? new Date().toISOString().slice(0, 10);
  const startDate = input.startDate ?? "2026-01-01";
  for (const videoId of ids) {
    try {
      const report = await youtubeJson<{
        columnHeaders?: Array<{ name?: string }>;
        rows?: Array<Array<number | string>>;
      }>(
        "https://youtubeanalytics.googleapis.com/v2/reports?" +
          new URLSearchParams({
            ids: "channel==MINE",
            startDate,
            endDate,
            metrics: "engagedViews,averageViewPercentage,shares,subscribersGained",
            filters: `video==${videoId}`,
          }),
        token,
      );
      const headers = (report.columnHeaders ?? []).map((header) => header.name ?? "");
      const row = report.rows?.[0];
      if (!row) continue;
      const value = (name: string) => optionalCount(row[headers.indexOf(name)]);
      output.set(videoId, {
        ...(output.get(videoId) ?? { videoId, capturedAt }),
        engagedViews: value("engagedViews"),
        averageViewPercentage: value("averageViewPercentage"),
        shares: value("shares"),
        subscribersGained: value("subscribersGained"),
        capturedAt,
      });
    } catch {
      // A refresh token issued before yt-analytics.readonly remains valid for
      // uploads and public stats. Missing retention is neutral in ranking.
      break;
    }
  }
  return output;
}

/** Exact dedupe across process crashes: the immutable episode id lives in the description. */
export async function findYouTubeVideoByEpisodeId(
  token: string,
  episodeId: string,
): Promise<YouTubeVideoResource | null> {
  const channels = await youtubeJson<{
    items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
  }>(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    token,
  );
  const uploads = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube account has no uploads playlist");
  const items = await youtubeJson<{
    items?: Array<{
      contentDetails?: { videoId?: string };
      snippet?: { title?: string; description?: string };
    }>;
  }>(
    "https://www.googleapis.com/youtube/v3/playlistItems?" +
      new URLSearchParams({
        part: "snippet,contentDetails",
        playlistId: uploads,
        maxResults: "50",
      }),
    token,
  );
  const marker = `AMM-EPISODE-ID: ${episodeId}`;
  const match = items.items?.find((item) => item.snippet?.description?.includes(marker));
  if (!match?.contentDetails?.videoId) return null;
  const videos = await youtubeJson<{ items?: YouTubeVideoResource[] }>(
    "https://www.googleapis.com/youtube/v3/videos?" +
      new URLSearchParams({ part: "snippet,status", id: match.contentDetails.videoId }),
    token,
  );
  return videos.items?.[0] ?? null;
}

async function publishYouTubeVideo(input: {
  credentials: YouTubeOAuthCredentials;
  episodeId: string;
  metadata: YouTubeShortMetadata;
  videoPath: string;
  expectedChannelId?: string;
  onUploadSession?: (url: string) => Promise<void>;
}): Promise<YouTubeVideoResource> {
  const token = await youtubeAccessToken(input.credentials);
  const account = await youtubeJson<{ items?: Array<{ id?: string }> }>(
    "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
    token,
  );
  const channelId = account.items?.[0]?.id;
  if (!channelId) throw new Error("YouTube OAuth token is not attached to a channel");
  if (input.expectedChannelId && channelId !== input.expectedChannelId) {
    throw new Error(`YouTube channel mismatch: expected ${input.expectedChannelId}, received ${channelId}`);
  }
  const existing = await findYouTubeVideoByEpisodeId(token, input.episodeId);
  if (existing) {
    if (
      existing.status?.privacyStatus !== "public" &&
      !(existing.status?.privacyStatus === "private" && existing.status.publishAt)
    ) {
      throw new Error(
        `existing YouTube video ${existing.id} is neither published nor validly scheduled`,
      );
    }
    return existing;
  }

  const bytes = await readFile(input.videoPath);
  const initiate = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?" +
      new URLSearchParams({
        uploadType: "resumable",
        part: "snippet,status",
        notifySubscribers: "true",
      }),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(bytes.byteLength),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(input.metadata),
    },
  );
  if (!initiate.ok) {
    throw new Error(`YouTube upload initiation ${initiate.status}: ${(await initiate.text()).slice(0, 800)}`);
  }
  const sessionUrl = initiate.headers.get("location");
  if (!sessionUrl) throw new Error("YouTube upload did not return a resumable session");
  await input.onUploadSession?.(sessionUrl);

  const uploaded = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.byteLength),
      "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
    },
    body: bytes,
  });
  const body = await uploaded.text();
  if (!uploaded.ok) throw new Error(`YouTube video upload ${uploaded.status}: ${body.slice(0, 800)}`);
  const video = JSON.parse(body) as YouTubeVideoResource;
  if (!video.id) throw new Error("YouTube upload succeeded without a video id");
  if (input.metadata.status.privacyStatus === "public") {
    if (video.status?.privacyStatus !== "public") {
      throw new Error(
        "YouTube accepted the file but did not make the explicitly requested manual release public; " +
        "the API project may require a YouTube compliance audit",
      );
    }
  } else if (video.status?.privacyStatus !== "private" || !video.status.publishAt) {
    throw new Error(
      "YouTube accepted the file but not the required scheduled-private status; " +
      "the API project may require a YouTube compliance audit",
    );
  }
  return video;
}

export async function publishYouTubeShort(input: {
  credentials: YouTubeOAuthCredentials;
  episode: ShortEpisodePackage;
  videoPath: string;
  publishAt: Date;
  publishImmediately?: boolean;
  expectedChannelId?: string;
  onUploadSession?: (url: string) => Promise<void>;
}): Promise<YouTubeVideoResource> {
  return publishYouTubeVideo({
    credentials: input.credentials,
    episodeId: input.episode.episodeId,
    metadata: buildYouTubeShortMetadata(input.episode, input.publishAt, {
      publishImmediately: input.publishImmediately,
    }),
    videoPath: input.videoPath,
    expectedChannelId: input.expectedChannelId,
    onUploadSession: input.onUploadSession,
  });
}

export async function publishYouTubeWeeklyShort(input: {
  credentials: YouTubeOAuthCredentials;
  episode: WeeklyShortEpisodePackage;
  videoPath: string;
  publishAt: Date;
  expectedChannelId?: string;
  onUploadSession?: (url: string) => Promise<void>;
}): Promise<YouTubeVideoResource> {
  return publishYouTubeVideo({
    credentials: input.credentials,
    episodeId: input.episode.episodeId,
    metadata: buildYouTubeWeeklyShortMetadata(input.episode, input.publishAt),
    videoPath: input.videoPath,
    expectedChannelId: input.expectedChannelId,
    onUploadSession: input.onUploadSession,
  });
}
