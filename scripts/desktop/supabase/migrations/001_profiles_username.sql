-- Unique public username for aq.aquin.app/user/<username>
-- Run in Supabase SQL editor (or your migration runner).

alter table public.profiles
  add column if not exists username text;

-- Normalize empties to null so unique index allows many unset usernames.
update public.profiles
set username = null
where username is not null and btrim(username) = '';

create unique index if not exists profiles_username_unique
  on public.profiles (lower(username))
  where username is not null;

comment on column public.profiles.username is
  'Public slug for https://aq.aquin.app/user/<username>';
