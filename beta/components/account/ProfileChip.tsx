"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Avvvatars from "avvvatars-react";
import { CircleNotch, Moon, Sun } from "@phosphor-icons/react";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme } from "@/contexts/ThemeContext";
import { userProfileHref, userProfilePath, validateUsername } from "@/lib/username";
import { cn } from "@/lib/utils";

interface Profile {
  name: string | null;
  username: string | null;
  avatar_url: string | null;
  email: string;
}

function ProfileUrlLink({
  username,
  className,
  onNavigate,
}: {
  username: string;
  className: string;
  onNavigate: () => void;
}) {
  const [label, setLabel] = useState(userProfilePath(username));
  useEffect(() => {
    setLabel(userProfileHref(username, window.location.origin));
  }, [username]);

  return (
    <Link href={userProfilePath(username)} className={className} onClick={onNavigate}>
      {label}
    </Link>
  );
}

export default function ProfileChip({
  popoverSide = "bottom",
  popoverAlign = "end",
}: {
  popoverSide?: "top" | "bottom" | "left" | "right";
  popoverAlign?: "start" | "center" | "end";
} = {}) {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createClient(), []);

  const [tempName, setTempName] = useState("");
  const [tempUsername, setTempUsername] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarFileName, setAvatarFileName] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from("profiles")
      .select("name, username, avatar_url, email")
      .eq("id", user.id)
      .single()
      .then(({ data, error }) => {
        if (data) {
          setProfile(data as Profile);
        } else {
          setProfile({
            name: null,
            username: null,
            avatar_url: null,
            email: user.email ?? "",
          });
          if (error) console.warn("[ProfileChip] profile fetch:", error.message);
        }
      });
  }, [user?.id, supabase, user?.email]);

  useEffect(() => {
    if (profile) {
      setTempName(profile.name || profile.email.split("@")[0]);
      setTempUsername(profile.username || "");
      setUsernameError(null);
    }
  }, [profile]);

  useEffect(() => {
    if (!profile?.avatar_url) {
      setAvatarFileName(null);
      return;
    }
    try {
      const path = new URL(profile.avatar_url).pathname;
      const saved = path.split("/").pop();
      setAvatarFileName(saved && saved !== "" ? saved : "avatar");
    } catch {
      setAvatarFileName("avatar");
    }
  }, [profile?.avatar_url]);

  const handleSaveName = async () => {
    if (!tempName.trim() || !user?.id) return;
    const next = tempName.trim();
    if (next === (profile?.name || profile?.email.split("@")[0])) return;
    setSavingName(true);
    const { error } = await supabase.from("profiles").update({ name: next }).eq("id", user.id);
    if (!error) setProfile(p => (p ? { ...p, name: next } : p));
    setSavingName(false);
  };

  const handleSaveUsername = async () => {
    if (!user?.id) return;
    const raw = tempUsername.trim();

    if (!raw) {
      if (!profile?.username) return;
    } else {
      const checked = validateUsername(raw);
      if (!checked.ok) {
        setUsernameError(checked.error);
        setTempUsername(profile?.username || "");
        return;
      }
      if (checked.username === profile?.username) return;
    }

    setSavingUsername(true);
    setUsernameError(null);
    try {
      const res = await fetch("/api/account/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: raw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUsernameError(typeof data.error === "string" ? data.error : "Could not save username.");
        setTempUsername(profile?.username || "");
        return;
      }
      const next = typeof data.username === "string" ? data.username : null;
      setProfile(p => (p ? { ...p, username: next } : p));
      setTempUsername(next || "");
    } catch {
      setUsernameError("Could not save username.");
      setTempUsername(profile?.username || "");
    } finally {
      setSavingUsername(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!profile?.email) return;
    await supabase.auth.resetPasswordForEmail(profile.email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setOpen(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    if (file.size > 5 * 1024 * 1024) return;
    setUploadingAvatar(true);
    try {
      const ext = file.name.split(".").pop();
      const filePath = `${user.id}/avatar.${ext}`;
      const { error: uploadError } = await supabase.storage.from("avatars").upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(filePath);
      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;
      await supabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", user.id);
      setProfile(p => (p ? { ...p, avatar_url: publicUrl } : p));
      setAvatarFileName(file.name);
    } catch (err) {
      console.error("[ProfileChip] avatar upload:", err);
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!user || !profile) return null;

  const displayName = profile.name || profile.email.split("@")[0];
  const avatarValue = profile.email || displayName;

  const avatarThumb = (size: number) =>
    profile.avatar_url ? (
      <img src={profile.avatar_url} alt="" className="size-full object-cover" />
    ) : (
      <Avvvatars value={avatarValue} style="shape" size={size} />
    );

  const linkTextClass =
    "text-sm text-stone-600 underline underline-offset-[3px] decoration-stone-300 transition-colors hover:text-stone-900 hover:decoration-stone-500 dark:text-stone-300 dark:decoration-white/20 dark:hover:text-[#f5f5f3] dark:hover:decoration-white/50";

  const nameInputClass =
    "w-full min-w-0 border-0 bg-transparent p-0 text-sm text-stone-600 underline underline-offset-[3px] decoration-stone-300 outline-none transition-colors placeholder:text-stone-400 focus:text-stone-900 focus:decoration-stone-500 dark:text-stone-300 dark:decoration-white/20 dark:placeholder:text-stone-500 dark:focus:text-[#f5f5f3] dark:focus:decoration-white/40";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="size-9 shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 outline-none transition-shadow hover:ring-black/20 data-[state=open]:ring-black/30 dark:ring-white/10 dark:hover:ring-white/20 dark:data-[state=open]:ring-white/30"
            title={displayName}
          >
            {avatarThumb(36)}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={popoverAlign}
          side={popoverSide}
          sideOffset={8}
          className="w-[min(calc(100vw-2rem),20rem)] rounded-2xl border-black/10 bg-white p-0 shadow-xl dark:border-white/10 dark:bg-black"
        >
          <PopoverHeader className="gap-0.5 px-5 pt-4 pb-2">
            <PopoverTitle className="text-base font-semibold text-stone-900 font-host-grotesk tracking-[-0.02em] dark:text-[#f5f5f3]">
              Profile
            </PopoverTitle>
            <PopoverDescription className="text-xs text-stone-400 dark:text-stone-500">
              Manage your Aquin account
            </PopoverDescription>
          </PopoverHeader>

          <div className="max-h-[min(70vh,560px)] overflow-y-auto px-5 pb-5 pt-2 no-scrollbar">
            <div className="flex flex-col items-start gap-2.5">
              <div className="mb-1 w-full">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
                  Appearance
                </p>
                <div
                  className="grid grid-cols-2 gap-1 rounded-xl border border-black/10 bg-black/[0.03] p-1 dark:border-white/10 dark:bg-white/[0.06]"
                  role="group"
                  aria-label="Color theme"
                >
                  <button
                    type="button"
                    onClick={() => setTheme("light")}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      theme === "light"
                        ? "bg-white text-stone-900 shadow-sm dark:bg-white dark:text-black"
                        : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-[#f5f5f3]",
                    )}
                    aria-pressed={theme === "light"}
                  >
                    <Sun className="size-3.5" weight="bold" />
                    Light
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme("dark")}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      theme === "dark"
                        ? "bg-black text-white shadow-sm dark:bg-white dark:text-black"
                        : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-[#f5f5f3]",
                    )}
                    aria-pressed={theme === "dark"}
                  >
                    <Moon className="size-3.5" weight="bold" />
                    Dark
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingAvatar}
                className={`${linkTextClass} max-w-full truncate text-left disabled:opacity-50`}
              >
                {uploadingAvatar ? (
                  <span className="inline-flex items-center gap-2">
                    <CircleNotch className="size-3.5 animate-spin" weight="bold" />
                    Uploading…
                  </span>
                ) : avatarFileName ? (
                  avatarFileName
                ) : (
                  "Change photo"
                )}
              </button>
              <div className="relative w-full">
                <input
                  value={tempName}
                  onChange={e => setTempName(e.target.value)}
                  onBlur={() => void handleSaveName()}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  disabled={savingName}
                  aria-label="Full name"
                  className={nameInputClass}
                />
                {savingName ? (
                  <CircleNotch
                    className="absolute right-0 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-stone-400"
                    weight="bold"
                  />
                ) : null}
              </div>

              <div className="relative w-full">
                <div className="flex items-baseline gap-0.5">
                  <span className="shrink-0 text-sm text-stone-400 dark:text-stone-500">@</span>
                  <input
                    value={tempUsername}
                    onChange={e => {
                      setTempUsername(e.target.value.toLowerCase());
                      setUsernameError(null);
                    }}
                    onBlur={() => void handleSaveUsername()}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={savingUsername}
                    aria-label="Username"
                    placeholder="username"
                    className={nameInputClass}
                  />
                </div>
                {savingUsername ? (
                  <CircleNotch
                    className="absolute right-0 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-stone-400"
                    weight="bold"
                  />
                ) : null}
                {usernameError ? (
                  <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{usernameError}</p>
                ) : null}
              </div>

              {profile.username ? (
                <ProfileUrlLink username={profile.username} className={linkTextClass} onNavigate={() => setOpen(false)} />
              ) : null}

              <p className={linkTextClass}>{profile.email}</p>

              <button type="button" onClick={() => void handlePasswordReset()} className={linkTextClass}>
                Send reset email
              </button>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className={`${linkTextClass} hover:text-red-700 hover:decoration-red-300 dark:hover:text-red-400 dark:hover:decoration-red-400/40`}
              >
                Sign out
              </button>
              <a href="mailto:aquin@aquin.app" className={linkTextClass}>
                aquin@aquin.app
              </a>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
    </>
  );
}
