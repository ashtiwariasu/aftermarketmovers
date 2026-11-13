import { Firestore } from "@google-cloud/firestore";
import { XMLParser } from "fast-xml-parser";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const ticker = flag("ticker")?.toUpperCase();
  const id = flag("id");
  const name = flag("name");
  const urlValue = flag("url");
  const authority = flag("authority") ?? "primary";
  const type = flag("type") ?? "rss";
  const pathPrefixValue = flag("path-prefix");
  const verifiedBy = flag("verified-by");

  if (!ticker || !/^[A-Z.\-]{1,6}$/.test(ticker) || !id || !name || !urlValue || !verifiedBy) {
    throw new Error(
      "Usage: npm run news:source -- --ticker AAPL --id apple-ir --name 'Apple Investor Relations' " +
      "--url https://example.com/rss --authority primary --type rss --verified-by you@example.com " +
      "[--path-prefix /newsroom/press-releases/]",
    );
  }
  if (!["primary", "publisher"].includes(authority)) throw new Error("authority must be primary or publisher");
  if (!["rss", "atom", "sitemap"].includes(type)) throw new Error("type must be rss, atom, or sitemap");
  if (type === "sitemap" && !pathPrefixValue?.startsWith("/")) {
    throw new Error("sitemap sources require --path-prefix beginning with /");
  }
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("source URL must use HTTPS");

  const response = await fetch(url, {
    headers: {
      "User-Agent": process.env.CONTACT_USER_AGENT || "AMM-self-hosted (set CONTACT_USER_AGENT)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`feed verification failed with HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") throw new Error("feed redirected away from HTTPS");
  const xml = await response.text();
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
    feed?: { entry?: unknown | unknown[] };
    urlset?: { url?: unknown | unknown[] };
  };
  let entryCount = 0;
  if (type === "sitemap") {
    const rows = parsed.urlset?.url;
    const entries = Array.isArray(rows) ? rows : rows ? [rows] : [];
    entryCount = entries.filter((unknownRow) => {
      const row = unknownRow as { loc?: unknown; lastmod?: unknown };
      if (!row.loc || !row.lastmod || !Number.isFinite(Date.parse(String(row.lastmod)))) return false;
      try {
        const entryUrl = new URL(String(row.loc));
        const directory = pathPrefixValue!.replace(/\/+$/, "");
        return entryUrl.protocol === "https:" && entryUrl.hostname === finalUrl.hostname &&
          entryUrl.pathname.startsWith(pathPrefixValue!) &&
          entryUrl.pathname.replace(/\/+$/, "") !== directory;
      } catch {
        return false;
      }
    }).length;
    if (entryCount === 0) {
      throw new Error("sitemap verification found no same-host, timestamped entries under the path prefix");
    }
  } else {
    const rows = parsed.rss?.channel?.item ?? parsed.feed?.entry;
    entryCount = Array.isArray(rows) ? rows.length : rows ? 1 : 0;
    if (entryCount === 0) throw new Error("feed verification found no RSS items or Atom entries");
  }

  const database = new Firestore();
  const ref = database.collection("companies").doc(ticker);
  await database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.data()?.newsSources ?? [];
    const source = {
      id,
      name,
      url: finalUrl.toString(),
      authority,
      type,
      ...(type === "sitemap" ? { pathPrefix: pathPrefixValue } : {}),
      enabled: true,
      verifiedAt: Date.now(),
      verifiedBy,
      verifiedHost: finalUrl.hostname,
    };
    const newsSources = [
      ...existing.filter((item: { id?: string }) => item.id !== id),
      source,
    ];
    transaction.set(ref, { symbol: ticker, newsSources }, { merge: true });
  });

  process.stdout.write(`Registered ${id} for ${ticker}: ${entryCount} entries verified on ${finalUrl.hostname}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
