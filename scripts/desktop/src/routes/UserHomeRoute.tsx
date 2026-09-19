import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CircleNotch } from "@phosphor-icons/react";
import { UserHomeClient } from "@/components/account/UserHomeClient";
import { createClient } from "@/lib/supabase/client";
import { normalizeUsername, userProfileHref, validateUsername } from "@/lib/username";

/**
 * Client equivalent of the former Next server page for /:username.
 * Same UserHomeClient UI; profile loaded via Supabase browser client.
 */
export function UserHomeRoute() {
  const { username: raw = "" } = useParams();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "missing" }
    | {
        status: "ok";
        username: string;
        displayName: string;
        avatarUrl: string | null;
        profileHref: string;
      }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const checked = validateUsername(raw);
    if (!checked.ok) {
      setState({ status: "missing" });
      return;
    }

    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("username, name, avatar_url")
      .eq("username", checked.username)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data?.username) {
          setState({ status: "missing" });
          return;
        }
        const username = normalizeUsername(data.username);
        setState({
          status: "ok",
          username,
          displayName: data.name?.trim() || username,
          avatarUrl: data.avatar_url,
          profileHref: userProfileHref(username, window.location.origin),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [raw]);

  if (state.status === "loading") {
    return (
      <div className="flex h-svh items-center justify-center bg-[#ebeae6] dark:bg-black">
        <CircleNotch className="h-6 w-6 animate-spin text-stone-400" weight="bold" />
      </div>
    );
  }

  if (state.status === "missing") {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-2 bg-background px-4 text-center">
        <h1 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f3]">User not found</h1>
        <p className="text-sm text-stone-500">This Aquin profile could not be found.</p>
      </div>
    );
  }

  return (
    <UserHomeClient
      username={state.username}
      displayName={state.displayName}
      avatarUrl={state.avatarUrl}
      profileHref={state.profileHref}
    />
  );
}
