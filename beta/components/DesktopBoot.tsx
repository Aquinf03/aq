"use client";

import { useEffect } from "react";
import { getDesktopApi } from "@/lib/desktop";

/** Marks the document when running inside Electron (drag regions, chrome spacing). */
export function DesktopBoot() {
  useEffect(() => {
    const api = getDesktopApi();
    if (!api) return;
    document.documentElement.dataset.aquinDesktop = "1";
    document.documentElement.classList.add("aquin-desktop");
    return () => {
      delete document.documentElement.dataset.aquinDesktop;
      document.documentElement.classList.remove("aquin-desktop");
    };
  }, []);
  return null;
}
