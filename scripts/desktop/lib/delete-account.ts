// app/actions/delete-account.ts

"use server";

import { createClient } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { redirect } from "next/navigation";

export async function deleteAccount() {
  const supabase = await createClient(); // await added
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Not authenticated");

  const { error } = await supabaseService.auth.admin.deleteUser(user.id);
  if (error) throw error;

  await supabase.auth.signOut();
  redirect("/");
}