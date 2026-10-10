import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AuthHeader } from "@/components/AuthHeader";
import { ProfileAvatar } from "@/components/account/ProfileAvatar";
import { getSupabaseService } from "@/lib/supabase/service";
import { constructMetadata } from "@/lib/utils";
import { normalizeUsername, userProfileHref, validateUsername } from "@/lib/username";

type PageProps = {
  params: Promise<{ username: string }>;
};

async function loadProfile(raw: string) {
  const checked = validateUsername(raw);
  if (!checked.ok) return null;

  try {
    const supabase = getSupabaseService();
    const { data, error } = await supabase
      .from("profiles")
      .select("username, name, avatar_url")
      .eq("username", checked.username)
      .maybeSingle();

    if (error) {
      console.error("[user profile]", error.message);
      return null;
    }
    if (!data?.username) return null;
    return data as { username: string; name: string | null; avatar_url: string | null };
  } catch (err) {
    console.error("[user profile]", err);
    return null;
  }
}

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL || "https://aquin.app";
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username: raw } = await params;
  const profile = await loadProfile(raw);
  if (!profile) {
    return constructMetadata({
      title: "User not found",
      description: "This Aquin profile could not be found.",
      robots: { index: false, follow: false },
    });
  }
  const titleName = profile.name?.trim() || profile.username;
  return constructMetadata({
    title: titleName,
    description: `Aquin profile for @${profile.username}`,
  });
}

export default async function UserProfilePage({ params }: PageProps) {
  const { username: raw } = await params;
  const profile = await loadProfile(raw);
  if (!profile) notFound();

  const username = normalizeUsername(profile.username);
  const displayName = profile.name?.trim() || username;
  const origin = await requestOrigin();

  return (
    <div className="relative min-h-screen bg-[#f5f5f3]">
      <AuthHeader />

      <div className="flex min-h-screen items-center justify-center px-4 py-24">
        <div className="w-full max-w-sm space-y-5 text-center">
          <div className="mx-auto size-20 overflow-hidden rounded-full ring-1 ring-stone-300/70">
            <ProfileAvatar avatarUrl={profile.avatar_url} seed={username} size={80} />
          </div>

          <div className="space-y-1">
            <h1 className="font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900">
              {displayName}
            </h1>
            <p className="font-host-grotesk text-sm text-stone-500">
              {userProfileHref(username, origin)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
