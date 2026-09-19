import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.AQUIN_API_PORT || 3001);
const UI_PORT = Number(process.env.AQUIN_UI_PORT || 3000);

const apiProxy = {
  target: `http://localhost:${API_PORT}`,
  // Keep browser Host as the Vite UI origin so Set-Cookie / redirects stay on :UI_PORT.
  changeOrigin: false,
  configure: (proxy: { on: (ev: string, fn: (...args: never[]) => void) => void }) => {
    proxy.on("proxyReq" as never, ((proxyReq: { setHeader: (k: string, v: string) => void }, req: { headers: { host?: string } }) => {
      if (req.headers.host) {
        proxyReq.setHeader("x-forwarded-host", req.headers.host);
        proxyReq.setHeader("x-forwarded-proto", "http");
      }
    }) as never);
  },
};

export default defineConfig(({ mode }) => {
  // Keep existing NEXT_PUBLIC_* .env keys working in the Vite UI.
  const env = loadEnv(mode, root, ["VITE_", "NEXT_PUBLIC_"]);
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }

  // Browser has no Node `process` — define NEXT_PUBLIC_* for any leftover process.env reads.
  const defineEnv: Record<string, string> = {
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
  };
  for (const [k, v] of Object.entries(env)) {
    defineEnv[`process.env.${k}`] = JSON.stringify(v);
  }

  return {
    root,
    publicDir: "public",
    plugins: [react()],
    define: defineEnv,
    resolve: {
      alias: {
        "@": root,
        "next/link": path.join(root, "src/shims/next-link.tsx"),
        "next/navigation": path.join(root, "src/shims/next-navigation.ts"),
      },
    },
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    server: {
      host: "localhost",
      port: UI_PORT,
      strictPort: true,
      proxy: {
        "/api": apiProxy,
        "/auth": apiProxy,
      },
    },
    preview: {
      host: "localhost",
      port: UI_PORT,
      strictPort: true,
      proxy: {
        "/api": apiProxy,
        "/auth": apiProxy,
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
    },
  };
});
