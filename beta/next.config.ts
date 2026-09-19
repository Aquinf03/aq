import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Electron loads the dev server from 127.0.0.1 / localhost — allow HMR websockets.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      {
        source: "/login",
        destination: "/",
        permanent: false,
      },
      {
        source: "/auth/desktop",
        destination: "/?view=desktop",
        permanent: false,
      },
      {
        source: "/app",
        destination: "/",
        permanent: false,
      },
      {
        source: "/app/:path*",
        destination: "/",
        permanent: false,
      },
      {
        source: "/changelog",
        destination: "https://aquin.app/changelog",
        permanent: true,
      },
      {
        source: "/changelog/:path*",
        destination: "https://aquin.app/changelog",
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
      {
        source: "/user/:username",
        destination: "/:username",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
