import { useCallback, useMemo } from "react";
import {
  useNavigate,
  useLocation,
  useParams as useRRParams,
  useSearchParams as useRRSearchParams,
} from "react-router-dom";

/** next/navigation-compatible shims for the Vite SPA. */

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => {
        void navigate(href);
      },
      replace: (href: string) => {
        void navigate(href, { replace: true });
      },
      back: () => {
        navigate(-1);
      },
      forward: () => {
        navigate(1);
      },
      refresh: () => {
        window.location.reload();
      },
      prefetch: async (_href: string) => {
        /* no-op in SPA */
      },
    }),
    [navigate],
  );
}

export function usePathname() {
  return useLocation().pathname;
}

export function useSearchParams() {
  const [params] = useRRSearchParams();
  return params;
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string>>() {
  return useRRParams() as T;
}

export function redirect(url: string): never {
  window.location.assign(url);
  throw new Error(`Redirecting to ${url}`);
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}

export function useSelectedLayoutSegment() {
  return null;
}

export function useSelectedLayoutSegments() {
  return [] as string[];
}

export function useServerInsertedHTML(_callback: () => React.ReactNode) {
  /* no-op */
}

export function useReportWebVitals(_cb: (metric: unknown) => void) {
  /* no-op */
}
