-- Native (ARCore Geospatial) support: tags gain a full 3D orientation
-- quaternion in EUS (east-up-south) frame, as reported by Geospatial poses.
-- Web sensor-AR tags leave it null. Apply after 0003.

alter table public.tags add column geo_quat jsonb; -- {x,y,z,w} EUS

drop function if exists public.place_tag(
  double precision, double precision, double precision, double precision,
  double precision, text, text, jsonb, uuid, jsonb);

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
  p_spot_xy    jsonb default null,
  p_geo_quat   jsonb default null
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
     device_meta, spot_id, spot_xy, geo_quat)
  values
    (auth.uid(),
     st_setsrid(st_makepoint(p_lon, p_lat, coalesce(p_alt, 0)), 4326)::geography,
     p_heading, p_accuracy, p_model_url, p_size_class, v_cost,
     coalesce(p_device, '{}'::jsonb), p_spot_id, p_spot_xy, p_geo_quat)
  returning * into v_tag;

  update public.profiles set used_volume = used_volume + v_cost where id = auth.uid();
  return v_tag;
end $$;

grant execute on function public.place_tag to authenticated;

-- nearby_tags gains geo_quat so native clients can restore full orientation.
drop function if exists public.nearby_tags(double precision, double precision, double precision, int);

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
  created_at  timestamptz,
  geo_quat    jsonb
)
language sql security definer set search_path = public stable as $$
  select
    t.id, t.creator_id,
    st_y(t.geog::geometry)  as lat,
    st_x(t.geog::geometry)  as lon,
    st_z(t.geog::geometry)  as alt,
    t.heading, t.accuracy_m, t.model_url, t.size_class,
    st_distance(t.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) as distance_m,
    count(a.user_id)                as appraisals,
    bool_or(a.user_id = auth.uid()) as appraised,
    t.created_at,
    t.geo_quat
  from public.tags t
  left join public.appraisals a on a.tag_id = t.id
  where t.status = 'active'
    and st_dwithin(t.geog, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_radius_m)
  group by t.id
  order by distance_m
  limit least(p_limit, 100);
$$;

grant execute on function public.nearby_tags to authenticated, anon;
