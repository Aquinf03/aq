function publicAppUrl(): string {
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  try {
    const v = (import.meta as ImportMeta & { env?: Record<string, string> }).env
      ?.NEXT_PUBLIC_APP_URL;
    if (v) return v;
  } catch {
    /* not Vite */
  }
  return "https://aq.aquin.app";
}

export const siteConfig = {
  name: "Aquin Labs",
  description:
    "Developer environment and framework for building and checking models. Train folders, aq CLI, Python kernel, and the in-train agent.",
  url: publicAppUrl(),
  keywords: [
    "Aquin",
    "Aquin Labs",
    "aq",
    "aquin.app",
    "train folder",
    "recipe.yaml",
    "CLI",
    "interpretability",
    "AI research",
  ],
  links: {
    email: "aquin@aquin.app",
    mainSite: "https://www.aquin.app",
    docs: "https://aquinf03.github.io/aq",
    home: "https://aq.aquin.app",
    changelog: "https://aquin.app/changelog",
    login: "/",
  },
};

export type SiteConfig = typeof siteConfig;
