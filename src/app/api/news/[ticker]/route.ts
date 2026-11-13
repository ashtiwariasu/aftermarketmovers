import { NextRequest, NextResponse } from "next/server";
import {
  getArticle,
  getCompanyNews,
  getNewsEvent,
  getSourceDocument,
} from "@/lib/newsStore";

interface Params {
  params: Promise<{ ticker: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const { ticker } = await params;
  const symbol = ticker.toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid ticker" }, { status: 400 });
  }
  const requested = Number(request.nextUrl.searchParams.get("limit") ?? 30);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requested) ? requested : 30));
  const links = await getCompanyNews(symbol, limit);
  const articles = (await Promise.all(links.map((link) => getArticle(link.articleId))))
    .filter((article) => article != null);
  const [documents, events] = await Promise.all([
    Promise.all([...new Set(articles.map((article) => article.sourceDocumentId ?? article.id))]
      .map((id) => getSourceDocument(id))),
    Promise.all([...new Set(articles.flatMap((article) => article.eventId ? [article.eventId] : []))]
      .map((id) => getNewsEvent(id))),
  ]);
  return NextResponse.json({
    ticker: symbol,
    asOf: Date.now(),
    articles,
    sourceDocuments: documents.filter((document) => document != null),
    events: events.filter((event) => event != null),
  });
}
