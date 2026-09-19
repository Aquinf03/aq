import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-roboto)", "system-ui", "sans-serif"],
        roboto: ["var(--font-roboto)", "system-ui", "sans-serif"],
        cardo: ["var(--font-cardo)", "serif"],
        "host-grotesk": ["var(--font-host-grotesk)", "system-ui", "sans-serif"],
        suisse: [
          '"Suisse Intl"',
          '"Suisse International"',
          "var(--font-roboto)",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
