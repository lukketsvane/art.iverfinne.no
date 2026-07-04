-- Caulk strokes (freehand wall drawing on spots) + profile stats.
-- Apply after 0004.

-- place_caulk: a freehand stroke on a spot. Points are [[x,y],...] in
-- target-image space (image width = 1 unit ≈ 1 m assumption for pricing).
-- Volume is computed SERVER-side from geometry: pi*r^2*length, damped by 0.1
-- so a half-metre medium stroke costs ~140 cm3 rather than draining the can.
create or replace function public.place_caulk(
  p_spot_id  uuid,
  p_lat      double precision,
  p_lon      double precision,
  p_accuracy double precision,
  p_points   jsonb,
  p_radius   double precision
) returns public.tags
language plpgsql security definer set search_path = public as $$
declare
  v_len  double precision := 0;
  v_n    int;
  v_cost numeric;
  v_size text;
  v_tag  public.tags;
  i int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.spots where id = p_spot_id and status = 'active') then
    raise exception 'spot not found';
  end if;

  v_n := jsonb_array_length(p_points);
  if v_n < 2 or v_n > 200 then raise exception 'invalid stroke'; end if;
  if p_radius is null or p_radius <= 0.005 or p_radius > 0.08 then
    raise exception 'invalid radius';
  end if;

  for i in 1 .. v_n - 1 loop
    v_len := v_len + sqrt(
      power((p_points->i->>0)::float8 - (p_points->(i-1)->>0)::float8, 2) +
      power((p_points->i->>1)::float8 - (p_points->(i-1)->>1)::float8, 2));
  end loop;
  if v_len > 10 then raise exception 'stroke too long'; end if;

  v_cost := greatest(10, round(pi() * p_radius * p_radius * v_len * 1e6 * 0.1));
  v_size := case when p_radius <= 0.02 then 's' when p_radius <= 0.04 then 'm' else 'l' end;

  perform 1 from public.profiles
    where id = auth.uid() and total_volume - used_volume >= v_cost
    for update;
  if not found then raise exception 'insufficient volume'; end if;

  insert into public.tags
    (creator_id, geog, heading, accuracy_m, model_url, size_class, volume_cm3,
     device_meta, spot_id, spot_xy)
  values
    (auth.uid(),
     st_setsrid(st_makepoint(p_lon, p_lat, 0), 4326)::geography,
     null, p_accuracy, 'caulk', v_size, v_cost,
     jsonb_build_object('placed_via', 'caulk-web'),
     p_spot_id,
     jsonb_build_object('points', p_points, 'r', p_radius))
  returning * into v_tag;

  update public.profiles set used_volume = used_volume + v_cost where id = auth.uid();
  return v_tag;
end $$;

-- Profile stats for the profile card: places, appraisals given/received.
create or replace function public.my_stats()
returns table (places bigint, given bigint, received bigint)
language sql security definer set search_path = public stable as $$
  select
    (select count(*) from public.tags where creator_id = auth.uid() and status = 'active'),
    (select count(*) from public.appraisals where user_id = auth.uid()),
    (select count(*) from public.appraisals a
       join public.tags t on t.id = a.tag_id
      where t.creator_id = auth.uid());
$$;

grant execute on function public.place_caulk to authenticated;
grant execute on function public.my_stats   to authenticated;
