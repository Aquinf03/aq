"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { AuthHeader } from "@/components/AuthHeader";
import {
  inputCls,
  labelCls,
  messageErrorCls,
  messageSuccessCls,
  primaryBtnCls,
} from "@/lib/auth-ui";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "error" | "success";
    text: string;
  } | null>(null);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.push("/");
      }
    };
    void checkSession();
  }, [supabase, router]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      setMessage({
        type: "error",
        text: "Passwords do not match",
      });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) throw error;

      setMessage({
        type: "success",
        text: "Password updated successfully! Redirecting...",
      });

      setTimeout(async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.user?.id) {
          const { resolveUserHomePath } = await import("@/lib/resolveUserHome");
          const path = await resolveUserHomePath(session.user.id);
          router.push(path || "/");
          return;
        }
        router.push("/");
      }, 2000);
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background">
      <AuthHeader showProfile />

      <div className="flex min-h-screen items-center justify-center px-4 py-24">
        <div className="w-full max-w-sm space-y-7">
          <div className="text-center">
            <h1 className="font-host-grotesk text-3xl font-semibold tracking-[-0.03em] text-stone-900 dark:text-stone-100">
              Reset password
            </h1>
            <p className="text-sm text-stone-500 mt-2 dark:text-stone-400">Enter your new password below</p>
          </div>

          <form className="space-y-3.5" onSubmit={handleResetPassword}>
            <div>
              <label htmlFor="password" className={labelCls}>
                New password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls + " pr-12"}
                  placeholder="••••••••"
                  minLength={6}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-stone-400 hover:text-stone-700 transition-colors"
                >
                  {showPassword ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirmPassword" className={labelCls}>
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type={showPassword ? "text" : "password"}
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputCls}
                placeholder="••••••••"
                minLength={6}
              />
            </div>

            {message && (
              <p className={message.type === "error" ? messageErrorCls : messageSuccessCls}>
                {message.text}
              </p>
            )}

            <button type="submit" disabled={loading} className={primaryBtnCls}>
              {loading ? "Resetting…" : "Reset password"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
