import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        destination: "https://aquinf03.github.io/aq",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: "https://aquinf03.github.io/aq",
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
