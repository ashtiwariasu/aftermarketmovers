import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { GoogleAnalytics } from "@next/third-parties/google";
import { Suspense } from "react";
import {
  Archivo,
  Instrument_Sans,
  IBM_Plex_Mono,
  Bricolage_Grotesque,
  Space_Grotesk,
} from "next/font/google";
import "./globals.css";
import FirstTouch from "@/components/FirstTouch";
import AnalyticsIdentity from "@/components/AnalyticsIdentity";
import RouteTransitionLoader from "@/components/RouteTransitionLoader";
import { isPublicProductionBuild, siteUrl } from "@/lib/environment";

const gaMeasurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
const production = isPublicProductionBuild();

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  axes: ["wdth"],
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "AMM — AI Stock Research While You Sleep",
    template: "%s | AMM",
  },
  description:
    "Five frontier AI analysts research the stocks you track and deliver one stress-tested thesis each morning.",
  applicationName: "AMM",
  creator: "After Market Movers",
  publisher: "Evolo Pty Ltd",
  category: "financial research",
  robots: production
    ? { index: true, follow: true }
    : { index: false, follow: false, nocache: true },
  openGraph: {
    type: "website",
    siteName: "AMM",
    title: "AMM — AI Stock Research While You Sleep",
    description:
      "Five frontier AI analysts research the stocks you track and deliver one stress-tested thesis each morning.",
    url: "https://aftermarketmovers.com",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "AMM — AI Stock Research While You Sleep",
    description:
      "Five frontier AI analysts research the stocks you track and deliver one stress-tested thesis each morning.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`dark h-full antialiased ${archivo.variable} ${instrument.variable} ${plexMono.variable} ${bricolage.variable} ${spaceGrotesk.variable}`}
      >
        <body className="min-h-full flex flex-col">
          <FirstTouch />
          <AnalyticsIdentity />
          <Suspense fallback={null}>
            <RouteTransitionLoader />
          </Suspense>
          {children}
        </body>
        {gaMeasurementId ? <GoogleAnalytics gaId={gaMeasurementId} /> : null}
      </html>
    </ClerkProvider>
  );
}
