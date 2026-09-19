"use client";

import { CircleNotch } from "@phosphor-icons/react";
import { AuthHeader } from "@/components/AuthHeader";
import { ProfileAvatar } from "@/components/account/ProfileAvatar";
import { WorkspaceHome } from "@/components/workspace/WorkspaceHome";
import { useAuth } from "@/contexts/AuthContext";
import { createClient } from "@/lib/supabase/client";
import { useEffect, useState } from "react";

type Props = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  profileHref: string;
};

/** Own home (workspace shell) vs public profile card. */
export function UserHomeClient({ username, displayName, avatarUrl, profileHref }: Props) {
  const { user, loading } = useAuth();
  const [ownerId, setOwnerId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle()
      .then(({ data }) => setOwnerId(data?.id ?? null));
  }, [username]);

  const isOwner =
    Boolean(user?.id) && ownerId !== undefined && ownerId !== null && user?.id === ownerId;

  if (loading || ownerId === undefined) {
    return (
      <div className="flex h-svh items-center justify-center bg-[#ebeae6] dark:bg-black">
        <CircleNotch className="h-6 w-6 animate-spin text-stone-400" weight="bold" />
      </div>
    );
  }

  if (isOwner) {
    return <WorkspaceHome displayName={displayName} />;
  }

  return (
    <div className="relative min-h-screen bg-background">
      <AuthHeader showProfile={Boolean(user)} />
      <div className="flex min-h-screen items-center justify-center px-4 py-24">
        <div className="w-full max-w-sm space-y-5 text-center">
          <div className="mx-auto size-20 overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/10">
            <ProfileAvatar avatarUrl={avatarUrl} seed={username} size={80} />
          </div>
          <div className="space-y-1">
            <h1 className="font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3]">
              {displayName}
            </h1>
            <p className="font-host-grotesk text-sm text-stone-500 dark:text-stone-400">{profileHref}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
