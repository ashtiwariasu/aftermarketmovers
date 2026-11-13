import type { MetadataRoute } from "next";
import { isPublicProductionBuild, siteUrl } from "@/lib/environment";

export default function robots(): MetadataRoute.Robots {
  if (!isPublicProductionBuild()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const site = siteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/mockups/"],
    },
    sitemap: `${site}/sitemap.xml`,
    host: site,
  };
}
