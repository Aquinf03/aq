/* eslint-disable @next/next/no-img-element */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Check, CircleNotch, Copy, Eye, EyeSlash } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthHeader } from "@/components/AuthHeader";
import { cn } from "@/lib/utils";
import {
  ghostBtnCls,
  inputCls,
  inputShellCls,
  inputInnerCls,
  continueInInputBtnCls,
  labelCls,
  messageErrorCls,
  messageSuccessCls,
  primaryBtnCls,
  secondaryBtnCls,
} from "@/lib/auth-ui";
import { resolveUserHomePath } from "@/lib/resolveUserHome";

type AuthStep = "email" | "password" | "signup" | "signup-password" | "desktop";
type DesktopPhase = "minting" | "ready" | "error";

type AuthPortalProps = {
  /** Skip full-page chrome when nested in another layout. */
  embedded?: boolean;
};

type CopyKey = "code" | "link";

function codeFromDeepLink(link: string): string | null {
  try {
    return new URL(link).searchParams.get("code");
  } catch {
    return null;
  }
}

function AuthPortalInner({ embedded = false }: AuthPortalProps) {
  const { user, loading: authLoading } = useAuth();
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewDesktop = searchParams.get("view") === "desktop";
  const client = (searchParams.get("client") || "").toLowerCase();
  const isCli = client === "cli" || client === "";

  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [desktopPhase, setDesktopPhase] = useState<DesktopPhase>("minting");
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [homeRedirecting, setHomeRedirecting] = useState(false);
  const minted = useRef(false);
  const homeNav = useRef(false);

  const desktopQuery = useMemo(() => {
    const q = new URLSearchParams();
    q.set("view", "desktop");
    if (client) q.set("client", client);
    return `/?${q.toString()}`;
  }, [client]);

  const goHome = useCallback(
    async (userId: string) => {
      if (homeNav.current) return;
      homeNav.current = true;
      setHomeRedirecting(true);
      const path = await resolveUserHomePath(userId);
      if (path) {
        router.replace(path);
        return;
      }
      homeNav.current = false;
      setHomeRedirecting(false);
      setMessage({ type: "error", text: "Could not open your home. Try again." });
    },
    [router],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      homeNav.current = false;
      setHomeRedirecting(false);
      if (viewDesktop) setStep("email");
      return;
    }
    if (user.email) setEmail(user.email);
    if (viewDesktop) {
      setStep("desktop");
      return;
    }
    void goHome(user.id);
  }, [user, authLoading, viewDesktop, goHome]);

  useEffect(() => {
    if (step !== "password") return;
    const t = window.setTimeout(() => document.getElementById("password")?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [step]);

  const mintDesktopCode = useCallback(async () => {
    setDesktopPhase("minting");
    setDesktopError(null);
    setCopied(null);
    try {
      const res = await fetch("/api/auth/desktop/mint", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Could not prepare sign-in code.",
        );
      }
      const link = String(data.deep_link || "");
      const raw =
        typeof data.code === "string" && data.code ? data.code : codeFromDeepLink(link);
      if (!raw) throw new Error("Invalid desktop handoff.");
      setCode(raw);
      setDeepLink(link.startsWith("aquin://") ? link : `aquin://auth?code=${encodeURIComponent(raw)}`);
      setDesktopPhase("ready");
    } catch (e) {
      setDesktopError(e instanceof Error ? e.message : "Something went wrong.");
      setDesktopPhase("error");
    }
  }, []);

  useEffect(() => {
    if (step !== "desktop" || !user || minted.current) return;
    minted.current = true;
    void mintDesktopCode();
  }, [step, user, mintDesktopCode]);

  const checkEmailExists = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("email")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
      setStep(data ? "password" : "signup");
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "An error occurred" });
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!profile) {
        await supabase.from("profiles").insert({
          id: data.user.id,
          email: data.user.email!,
        });
      }
      if (viewDesktop) {
        router.replace(desktopQuery);
        return;
      }
      await goHome(data.user.id);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "An error occurred" });
    } finally {
      setLoading(false);
    }
  };

  const handleSignupNext = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setStep("signup-password");
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name: name || null } },
      });
      if (error) throw error;
      if (data.user) {
        const { error: profileError } = await supabase.from("profiles").insert({
          id: data.user.id,
          email: data.user.email!,
          name: name || null,
          avatar_url: null,
        });
        if (profileError) throw profileError;

        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        await fetch("/api/account/username/allocate", { method: "POST" }).catch(() => null);
        if (viewDesktop) {
          router.replace(desktopQuery);
          return;
        }
        await goHome(data.user.id);
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "An error occurred" });
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setMessage({ type: "error", text: "Please enter your email first" });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      if (error) throw error;
      setMessage({ type: "success", text: "Password reset link sent to your email." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "An error occurred" });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setStep("email");
    setPassword("");
    setName("");
    setMessage(null);
  };

  const copyText = async (which: CopyKey, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* select-all still works */
    }
  };

  if (authLoading || homeRedirecting) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-background",
          embedded ? "min-h-[40vh] py-16" : "min-h-screen",
        )}
      >
        <CircleNotch className="h-6 w-6 animate-spin text-stone-400 dark:text-stone-500" weight="bold" />
      </div>
    );
  }

  const body = (
        <div className={cn("w-full max-w-md", embedded && "mx-auto")}>
          {step === "desktop" && user && (
            <div className="space-y-6 text-center">
              <div>
                <h1 className="font-host-grotesk text-2xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3]">
                  {isCli ? "Sign in for Aquin CLI" : "Sign in for CLI / desktop"}
                </h1>
                <p className="mt-2 text-sm text-stone-500 dark:text-stone-400 dark:text-stone-500">
                  {isCli
                    ? "Copy the code and paste it into the terminal where aq login is waiting."
                    : "Copy the code for the CLI, or open the desktop app with the button below."}
                </p>
              </div>

              {desktopPhase === "minting" && (
                <div className="flex justify-center py-2">
                  <CircleNotch className="h-5 w-5 animate-spin text-stone-400 dark:text-stone-500" weight="bold" />
                </div>
              )}

              {desktopError && (
                <p className={messageErrorCls + " text-left"}>
                  {desktopError}
                </p>
              )}

              {desktopPhase === "ready" && code && (
                <div className="space-y-3 text-left">
                  <p className="text-center text-sm text-stone-500 dark:text-stone-400 dark:text-stone-500">
                    In the terminal where <span className="font-mono text-stone-700 dark:text-stone-300">aq login</span> is waiting,
                    paste the code or the full <span className="font-mono">aquin://</span> link.
                  </p>
                  <div className="space-y-2 rounded-xl border border-stone-200 dark:border-white/10 bg-white/80 dark:bg-black/80 px-3 py-2.5">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">Code</p>
                    <p className="break-all font-mono text-[11px] leading-relaxed text-stone-800 dark:text-[#f5f5f3] select-all">
                      {code}
                    </p>
                    <button
                      type="button"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-black/90"
                      onClick={() => void copyText("code", code)}
                    >
                      {copied === "code" ? <Check className="h-3.5 w-3.5" weight="bold" /> : <Copy className="h-3.5 w-3.5" weight="bold" />}
                      {copied === "code" ? "Copied" : "Copy code"}
                    </button>
                  </div>
                  {deepLink && (
                    <div className="space-y-2 rounded-xl border border-stone-200 dark:border-white/10 bg-white/80 dark:bg-black/80 px-3 py-2.5">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">aquin:// link</p>
                      <p className="break-all font-mono text-[11px] text-stone-700 dark:text-stone-300 select-all">{deepLink}</p>
                      <button
                        type="button"
                        className={secondaryBtnCls}
                        onClick={() => void copyText("link", deepLink)}
                      >
                        {copied === "link" ? <Check className="h-3.5 w-3.5" weight="bold" /> : <Copy className="h-3.5 w-3.5" weight="bold" />}
                        {copied === "link" ? "Copied" : "Copy link"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {desktopPhase === "error" && (
                <button
                  type="button"
                  onClick={() => {
                    minted.current = false;
                    void mintDesktopCode();
                  }}
                  className={primaryBtnCls}
                >
                  Try again
                </button>
              )}

              <button
                type="button"
                onClick={() => router.replace("/")}
                className="block w-full text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 dark:text-stone-300"
              >
                &larr; Back
              </button>
            </div>
          )}

          {(step === "email" || step === "password") && (
            <div className="mx-auto flex w-full max-w-md flex-col items-center">
              <div className="relative mb-7 h-10 w-full">
                <h1
                  className={cn(
                    "font-host-grotesk absolute inset-x-0 top-0 text-center text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3] leading-tight transition-all duration-500 ease-out",
                    step === "email"
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none -translate-y-2 opacity-0",
                  )}
                >
                  {viewDesktop ? "Sign in for Aquin CLI" : "Get Started with aq"}
                </h1>
                <h1
                  className={cn(
                    "font-host-grotesk absolute inset-x-0 top-0 text-center text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3] leading-tight transition-all duration-500 ease-out",
                    step === "password"
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none translate-y-2 opacity-0",
                  )}
                >
                  Enter password
                </h1>
              </div>

              {viewDesktop && step === "email" && (
                <p className="mb-7 text-center text-sm text-stone-500 dark:text-stone-400 dark:text-stone-500">
                  Use your aquin.app account, then paste the code into aq login.
                </p>
              )}

              <form
                className="w-full space-y-3.5"
                onSubmit={step === "email" ? checkEmailExists : handleSignIn}
              >
                <div className={inputShellCls}>
                  <input
                    id="email"
                    type="email"
                    required={step === "email"}
                    readOnly={step === "password"}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={cn(
                      inputInnerCls,
                      step === "password" && "cursor-default text-stone-500 dark:text-stone-400 dark:text-stone-500",
                    )}
                    placeholder="you@example.com"
                    aria-label="Email"
                    autoFocus={step === "email"}
                    tabIndex={step === "password" ? -1 : 0}
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    aria-hidden={step === "password"}
                    className={cn(
                      continueInInputBtnCls,
                      "overflow-hidden transition-all duration-500 ease-out",
                      step === "email"
                        ? "max-w-[8.5rem] translate-x-0 opacity-100"
                        : "pointer-events-none max-w-0 px-0 opacity-0",
                    )}
                  >
                    {loading && step === "email" ? (
                      <CircleNotch className="size-4 animate-spin" weight="bold" />
                    ) : (
                      "Continue"
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    aria-hidden={step === "email"}
                    className={cn(
                      "shrink-0 overflow-hidden whitespace-nowrap text-xs font-host-grotesk text-stone-500 dark:text-stone-400 dark:text-stone-500 transition-all duration-500 ease-out hover:text-stone-900 dark:hover:text-[#f5f5f3] dark:text-[#f5f5f3]",
                      step === "password"
                        ? "max-w-[4rem] translate-x-0 pr-1 opacity-100"
                        : "pointer-events-none max-w-0 opacity-0",
                    )}
                  >
                    change
                  </button>
                </div>

                <div
                  className={cn(
                    "grid transition-[grid-template-rows,opacity,margin-top] duration-500 ease-out",
                    step === "password"
                      ? "mt-3.5 grid-rows-[1fr] opacity-100"
                      : "mt-0 grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="min-h-0 space-y-3.5 overflow-hidden">
                    <div className="relative">
                      <input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        required={step === "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={inputCls + " pr-12"}
                        placeholder="••••••••"
                        tabIndex={step === "password" ? 0 : -1}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 flex items-center pr-4 text-stone-400 dark:text-stone-500 transition-colors hover:text-stone-700 dark:hover:text-[#f5f5f3] dark:text-stone-300"
                      >
                        {showPassword ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleForgotPassword}
                        className="text-xs font-host-grotesk text-stone-400 dark:text-stone-500 transition-colors hover:text-stone-700 dark:hover:text-[#f5f5f3] dark:text-stone-300"
                      >
                        forgot password?
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={loading}
                      className={primaryBtnCls + " transition-colors"}
                    >
                      {loading && step === "password" ? (
                        <CircleNotch className="animate-spin h-4 w-4" weight="bold" />
                      ) : null}
                      {loading && step === "password" ? "Signing in…" : "Sign In"}
                    </button>
                  </div>
                </div>

                {message && (
                  <p className={message.type === "error" ? messageErrorCls : messageSuccessCls}>
                    {message.text}
                  </p>
                )}
              </form>
            </div>
          )}

          {step === "signup" && (
            <div className="space-y-7">
              <div>
                <h1 className="font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3] leading-tight">Create account</h1>
                <p className="text-sm text-stone-500 dark:text-stone-400 dark:text-stone-500 mt-1.5 leading-relaxed">
                  Set up your Aquin account to get started.
                </p>
              </div>

              <form className="space-y-3.5" onSubmit={handleSignupNext}>
                <div>
                  <div className="flex items-center gap-2">
                    <input type="email" value={email} disabled aria-label="Email" className="flex-1 px-4 py-3 rounded-xl border border-stone-200 dark:border-white/10 bg-stone-100 dark:bg-white/10 text-stone-500 dark:text-stone-400 dark:text-stone-500 text-sm" />
                    <button type="button" onClick={resetForm} className="text-xs font-host-grotesk text-stone-500 dark:text-stone-400 dark:text-stone-500 hover:text-stone-900 dark:hover:text-[#f5f5f3] dark:text-[#f5f5f3] whitespace-nowrap transition-colors">
                      change
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="name" className={labelCls}>Name</label>
                  <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Jane Smith" autoFocus />
                </div>

                <button type="submit" className={primaryBtnCls + " transition-colors"}>
                  Continue
                </button>
              </form>
            </div>
          )}

          {step === "signup-password" && (
            <div className="space-y-7">
              <div>
                <p className="text-xs font-host-grotesk uppercase tracking-widest text-stone-400 dark:text-stone-500 mb-3">Almost there</p>
                <h1 className="font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-[#f5f5f3] leading-tight">Choose a password</h1>
                <p className="text-sm text-stone-500 dark:text-stone-400 dark:text-stone-500 mt-1.5">Secure your new Aquin account.</p>
              </div>

              <form className="space-y-3.5" onSubmit={handleSignUp}>
                <div>
                  <label htmlFor="signup-password" className={labelCls}>Password</label>
                  <div className="relative">
                    <input
                      id="signup-password"
                      type={showPassword ? "text" : "password"}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={inputCls + " pr-12"}
                      placeholder="••••••••"
                      minLength={6}
                      autoFocus
                    />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-[#f5f5f3] dark:text-stone-300 transition-colors">
                      {showPassword ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs font-host-grotesk text-stone-400 dark:text-stone-500 mt-1.5">min. 6 characters</p>
                </div>

                {message && (
                  <p className={message.type === "error" ? messageErrorCls : messageSuccessCls}>
                    {message.text}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className={primaryBtnCls + " transition-colors"}
                >
                  {loading ? <CircleNotch className="animate-spin h-4 w-4" weight="bold" /> : null}
                  {loading ? "Creating account…" : "Create account"}
                </button>

                <button type="button" onClick={() => setStep("signup")} className="w-full py-2 text-xs font-host-grotesk text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-[#f5f5f3] dark:text-stone-300 transition-colors">
                  &larr; back
                </button>
              </form>
            </div>
          )}
        </div>
  );

  if (embedded) {
    return <div className="py-6 sm:py-10">{body}</div>;
  }

  return (
    <div className="relative min-h-screen bg-background">
      <AuthHeader showProfile={Boolean(user && step === "desktop")} />
      <div className="flex min-h-screen items-center justify-center overflow-y-auto px-4 py-24">
        {body}
      </div>
    </div>
  );
}

export default function AuthPortal({ embedded = false }: AuthPortalProps) {
  return (
    <Suspense
      fallback={
        <div
          className={cn(
            "flex items-center justify-center bg-background",
            embedded ? "min-h-[40vh] py-16" : "min-h-screen",
          )}
        >
          <CircleNotch className="h-6 w-6 animate-spin text-stone-400 dark:text-stone-500" weight="bold" />
        </div>
      }
    >
      <AuthPortalInner embedded={embedded} />
    </Suspense>
  );
}
