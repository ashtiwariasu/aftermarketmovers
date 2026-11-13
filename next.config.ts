import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      // Tracker pages retired — AMM is a research desk, not a movers ticker.
      { source: "/premarket", destination: "/", permanent: true },
      { source: "/after-hours", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
