"use client";

import Avvvatars from "avvvatars-react";

export function ProfileAvatar({
  avatarUrl,
  seed,
  size,
}: {
  avatarUrl: string | null;
  seed: string;
  size: number;
}) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={avatarUrl} alt="" className="size-full object-cover" />
    );
  }
  return <Avvvatars value={seed} style="shape" size={size} />;
}
