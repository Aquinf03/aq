import type { NextConfig } from "next";

/** Legacy host — auth UI lives at aquin.app/aq/; keep this app until DNS cutover is verified. */
const AQ = "https://aquin.app/aq/";
const AQUIN = "https://aquin.app";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: AQ,
        permanent: true,
      },
      {
        source: "/login",
        destination: AQ,
        permanent: true,
      },
      {
        source: "/auth/desktop",
        destination: `${AQ}?view=desktop`,
        permanent: true,
      },
      {
        source: "/app",
        destination: AQ,
        permanent: true,
      },
      {
        source: "/app/:path*",
        destination: AQ,
        permanent: true,
      },
      {
        source: "/auth/reset-password",
        destination: `${AQUIN}/auth/reset-password`,
        permanent: true,
      },
      {
        source: "/auth/callback",
        destination: `${AQUIN}/auth/callback`,
        permanent: false,
      },
      {
        source: "/user/:username",
        destination: `${AQUIN}/user/:username`,
        permanent: true,
      },
      {
        source: "/changelog",
        destination: "https://aquinf03.github.io/aq/changelog",
        permanent: true,
      },
      {
        source: "/changelog/:path*",
        destination: "https://aquinf03.github.io/aq/changelog",
        permanent: true,
      },
      {
        source: "/docs",
        destination: "https://aquinf03.github.io/aq/documentation/",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: "https://aquinf03.github.io/aq/documentation/:path*",
        permanent: true,
      },
      // Catch-all: any leftover page → aquin.app/aq (releases/framework stay on the CF worker)
      {
        source: "/:path*",
        destination: AQ,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
