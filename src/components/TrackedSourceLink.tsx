"use client";

import type { CSSProperties, ReactNode } from "react";
import { captureAnalyticsEvent } from "@/lib/analytics";

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export default function TrackedSourceLink({
  href,
  ticker,
  section,
  publisher,
  authority,
  bucket,
  sourceId,
  videoId,
  className,
  style,
  children,
}: {
  href: string;
  ticker: string;
  section: "filing" | "news" | "video_source";
  publisher?: string;
  authority?: string;
  bucket?: string;
  sourceId?: string;
  videoId?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={style}
      onClick={() => {
        captureAnalyticsEvent("stock_source_clicked", {
          ticker,
          section,
          publisher,
          authority,
          bucket,
          source_id: sourceId,
          video_id: videoId,
          source_host: sourceHost(href),
        });
      }}
    >
      {children}
    </a>
  );
}
