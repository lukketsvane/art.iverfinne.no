-- Spots: wall-photo anchors for centimetre-precise, shared placement.
-- A spot is a photographed wall/surface; its compiled tracking target lets
-- every phone localize against the SAME physical feature — precision web AR
-- without markers. Apply after 0002.

create table public.spots (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles (id) on delete cascade,
  name        text,
  geog        geography(point, 4326) not null,
  accuracy_m  double precision,
  image_path  text not null,   -- storage: reference photo (jpg)
  target_path text not null,   -- storage: compiled .mind tracking target
  status      text not null default 'active' check (status in ('active', 'hidden', 'removed')),
  created_at  timestamptz not null default now()
);

create index spots_geog_idx on public.spots using gist (geog);
alter table public.spots enable row level security;
create policy "active spots are readable"
  on public.spots for select using (status = 'active' or creator_id = auth.uid());

-- Tags can be pinned to a spot: spot_xy = {x, y, s} in target-image space
-- (origin centre, x right, y up, image width = 1 unit).
alter table public.tags
  add column spot_id uuid references public.spots (id) on delete set null,
  add column spot_xy jsonb;

create index tags_spot_idx on public.tags (spot_id);

create or replace function public.create_spot(
  p_lat         double precision,
  p_lon         double precision,
  p_accuracy    double precision,
  p_name        text,
  p_image_path  text,
  p_target_path text
) returns public.spots
language plpgsql security definer set search_path = public as $$
declare v public.spots;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.spots (creator_id, geog, accuracy_m, name, image_path, target_path)
  values (auth.uid(),
          st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
          p_accuracy, p_name, p_image_path, p_target_path)
  returning * into v;
  return v;
end $$;

create or replace function public.get_spot(p_spot_id uuid)
returns table (
  id uuid, creator_id uuid, name text,
  lat double precision, lon double precision, accuracy_m double precision,
  image_path text, target_path text, tag_count bigint, created_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select s.id, s.creator_id, s.name,
         st_y(s.geog::geometry), st_x(s.geog::geometry), s.accuracy_m,
         s.image_path, s.target_path,
         count(t.id) filter (where t.status = 'active'),
         s.created_at
  from public.spots s
  left join public.tags t on t.spot_id = s.id
  where s.id = p_spot_id and s.status = 'active'
  group by s.id;
$$;

create or replace function public.nearby_spots(
  p_lat double precision, p_lon double precision,
  p_radius_m double precision default 300, p_limit int default 20
) returns table (
  id uuid, name text, lat double precision, lon double precision,
  distance_m double precision, image_path text, target_path text, tag_count bigint
)
language sql security definer set search_path = public stable as $$
  select s.id, s.name,
         st_y(s.geog::geometry), st_x(s.geog::geometry),
         st_distance(s.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography),
         s.image_path, s.target_path,
         count(t.id) filter (where t.status = 'active')
  from public.spots s
  left join public.tags t on t.spot_id = s.id
  where s.status = 'active'
    and st_dwithin(s.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_radius_m)
  group by s.id
  order by 5
  limit least(p_limit, 50);
$$;

create or replace function public.spot_tags(p_spot_id uuid)
returns table (
  id uuid, creator_id uuid, model_url text, size_class text, spot_xy jsonb,
  appraisals bigint, appraised boolean, created_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select t.id, t.creator_id, t.model_url, t.size_class, t.spot_xy,
         count(a.user_id), bool_or(a.user_id = auth.uid()), t.created_at
  from public.tags t
  left join public.appraisals a on a.tag_id = t.id
  where t.spot_id = p_spot_id and t.status = 'active'
  group by t.id
  order by t.created_at;
$$;

-- place_tag gains optional spot params (signature change: drop + recreate).
drop function if exists public.place_tag(
  double precision, double precision, double precision, double precision,
  double precision, text, text, jsonb);

create or replace function public.place_tag(
  p_lat        double precision,
  p_lon        double precision,
  p_alt        double precision,
  p_heading    double precision,
  p_accuracy   double precision,
  p_model_url  text,
  p_size_class text,
  p_device     jsonb default '{}'::jsonb,
  p_spot_id    uuid default null,
  p_spot_xy    jsonb default null
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

  if p_spot_id is not null and not exists (
    select 1 from public.spots where id = p_spot_id and status = 'active'
  ) then
    raise exception 'spot not found';
  end if;

  perform 1 from public.profiles
    where id = auth.uid()
      and total_volume - used_volume >= v_cost
    for update;
  if not found then
    raise exception 'insufficient volume';
  end if;

  insert into public.tags
    (creator_id, geog, heading, accuracy_m, model_url, size_class, volume_cm3,
     device_meta, spot_id, spot_xy)
  values
    (auth.uid(),
     st_setsrid(st_makepoint(p_lon, p_lat, coalesce(p_alt, 0)), 4326)::geography,
     p_heading, p_accuracy, p_model_url, p_size_class, v_cost,
     coalesce(p_device, '{}'::jsonb), p_spot_id, p_spot_xy)
  returning * into v_tag;

  update public.profiles set used_volume = used_volume + v_cost where id = auth.uid();
  return v_tag;
end $$;

grant execute on function public.place_tag    to authenticated;
grant execute on function public.create_spot  to authenticated;
grant execute on function public.get_spot     to authenticated, anon;
grant execute on function public.nearby_spots to authenticated, anon;
grant execute on function public.spot_tags    to authenticated, anon;

-- Public storage bucket for spot photos + compiled targets. Wrapped so the
-- migration survives if the dashboard role can't touch storage policies —
-- in that case create bucket "spots" (public) manually under Storage.
insert into storage.buckets (id, name, public)
  values ('spots', 'spots', true)
  on conflict (id) do nothing;

do $$
begin
  begin
    create policy "spots upload" on storage.objects
      for insert to authenticated with check (bucket_id = 'spots');
  exception when others then
    raise notice 'could not create upload policy: %', sqlerrm;
  end;
  begin
    create policy "spots read" on storage.objects
      for select using (bucket_id = 'spots');
  exception when others then
    raise notice 'could not create read policy: %', sqlerrm;
  end;
end $$;
