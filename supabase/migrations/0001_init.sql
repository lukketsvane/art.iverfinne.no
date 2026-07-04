-- ART — AR Tagging · MVP schema
-- Apply with: supabase db push   (or paste into the Supabase SQL editor)
-- Requires: Anonymous sign-in enabled (Dashboard → Auth → Providers → Anonymous)

create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user; volume in cm³ ("spray can")
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  handle       text unique,
  total_volume numeric not null default 500,  -- signup grant: one can = 500 cm³
  used_volume  numeric not null default 0,
  created_at   timestamptz not null default now(),
  constraint volume_sane check (used_volume >= 0 and used_volume <= total_volume)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- tags — placed content. PointZ = lon/lat/alt (WGS84). Pose logging fields
-- (heading, accuracy_m, device_meta) are REQUIRED for the v2 VPS migration.
-- ---------------------------------------------------------------------------
create table public.tags (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles (id) on delete cascade,
  geog        geography(pointz, 4326) not null,
  heading     double precision,          -- compass heading at placement (deg)
  accuracy_m  double precision,          -- GPS accuracy reported at placement
  model_url   text not null,             -- 'builtin:<id>' or storage URL (GLB)
  size_class  text not null check (size_class in ('s', 'm', 'l')),
  volume_cm3  numeric not null,
  status      text not null default 'active' check (status in ('active', 'hidden', 'removed')),
  device_meta jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index tags_geog_idx on public.tags using gist (geog);
create index tags_creator_idx on public.tags (creator_id);
create index tags_status_idx on public.tags (status);

-- ---------------------------------------------------------------------------
-- appraisals — free; one per user per tag; credits the creator's can
-- ---------------------------------------------------------------------------
create table public.appraisals (
  tag_id     uuid not null references public.tags (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tag_id, user_id)
);

create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  tag_id      uuid not null references public.tags (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (tag_id, reporter_id)
);

-- ---------------------------------------------------------------------------
-- RLS — reads are open; ALL writes go through security-definer RPCs
-- ---------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.tags       enable row level security;
alter table public.appraisals enable row level security;
alter table public.reports    enable row level security;

create policy "profiles are readable"        on public.profiles   for select using (true);
create policy "active tags are readable"     on public.tags       for select using (status = 'active' or creator_id = auth.uid());
create policy "appraisals are readable"      on public.appraisals for select using (true);
create policy "own reports are readable"     on public.reports    for select using (reporter_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: place_tag — atomic volume check + insert + debit
-- ---------------------------------------------------------------------------
create or replace function public.place_tag(
  p_lat        double precision,
  p_lon        double precision,
  p_alt        double precision,
  p_heading    double precision,
  p_accuracy   double precision,
  p_model_url  text,
  p_size_class text,
  p_device     jsonb default '{}'::jsonb
) returns public.tags
language plpgsql security definer set search_path = public as $$
declare
  v_cost numeric;
  v_tag  public.tags;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_cost := case p_size_class
    when 's' then 50
    when 'm' then 125
    when 'l' then 250
    else null end;
  if v_cost is null then
    raise exception 'invalid size_class %', p_size_class;
  end if;

  -- Lock the profile row so concurrent placements cannot overspend.
  perform 1 from public.profiles
    where id = auth.uid()
      and total_volume - used_volume >= v_cost
    for update;
  if not found then
    raise exception 'insufficient volume';
  end if;

  insert into public.tags
    (creator_id, geog, heading, accuracy_m, model_url, size_class, volume_cm3, device_meta)
  values
    (auth.uid(),
     st_setsrid(st_makepoint(p_lon, p_lat, coalesce(p_alt, 0)), 4326)::geography,
     p_heading, p_accuracy, p_model_url, p_size_class, v_cost, coalesce(p_device, '{}'::jsonb))
  returning * into v_tag;

  update public.profiles set used_volume = used_volume + v_cost where id = auth.uid();
  return v_tag;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: appraise_tag — one per user per tag, no self-appraisal, +25 cm³ creator
-- ---------------------------------------------------------------------------
create or replace function public.appraise_tag(p_tag_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select creator_id into v_creator from public.tags
    where id = p_tag_id and status = 'active';
  if v_creator is null then
    raise exception 'tag not found';
  end if;
  if v_creator = auth.uid() then
    raise exception 'cannot appraise own tag';
  end if;

  insert into public.appraisals (tag_id, user_id) values (p_tag_id, auth.uid());
  -- PK violation (already appraised) aborts before the credit below.

  update public.profiles set total_volume = total_volume + 25 where id = v_creator;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: nearby_tags — ST_DWithin over GIST index, appraisal counts included
-- ---------------------------------------------------------------------------
create or replace function public.nearby_tags(
  p_lat      double precision,
  p_lon      double precision,
  p_radius_m double precision default 150,
  p_limit    int default 50
) returns table (
  id          uuid,
  creator_id  uuid,
  lat         double precision,
  lon         double precision,
  alt         double precision,
  heading     double precision,
  accuracy_m  double precision,
  model_url   text,
  size_class  text,
  distance_m  double precision,
  appraisals  bigint,
  appraised   boolean,
  created_at  timestamptz
)
language sql security definer set search_path = public stable as $$
  select
    t.id, t.creator_id,
    st_y(t.geog::geometry)  as lat,
    st_x(t.geog::geometry)  as lon,
    st_z(t.geog::geometry)  as alt,
    t.heading, t.accuracy_m, t.model_url, t.size_class,
    st_distance(t.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) as distance_m,
    count(a.user_id)                                        as appraisals,
    bool_or(a.user_id = auth.uid())                         as appraised,
    t.created_at
  from public.tags t
  left join public.appraisals a on a.tag_id = t.id
  where t.status = 'active'
    and st_dwithin(t.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_radius_m)
  group by t.id
  order by distance_m
  limit least(p_limit, 100);
$$;

-- ---------------------------------------------------------------------------
-- RPC: report_tag — moderation stub; 3 reports auto-hide
-- ---------------------------------------------------------------------------
create or replace function public.report_tag(p_tag_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.reports (tag_id, reporter_id, reason)
    values (p_tag_id, auth.uid(), p_reason)
    on conflict do nothing;
  update public.tags set status = 'hidden'
    where id = p_tag_id
      and status = 'active'
      and (select count(*) from public.reports where tag_id = p_tag_id) >= 3;
end $$;

-- Direct table writes are blocked: no insert/update/delete policies exist,
-- and clients only hold the anon/authenticated roles. RPCs are the only door.
grant execute on function public.place_tag     to authenticated;
grant execute on function public.appraise_tag  to authenticated;
grant execute on function public.nearby_tags   to authenticated, anon;
grant execute on function public.report_tag    to authenticated;
