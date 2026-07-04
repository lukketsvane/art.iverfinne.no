-- Voxel caulk: volumetric building. Cells are [i,j,k] grid indices in
-- target-image space (voxel edge = p_vox image units); k stacks off the wall.
-- Cost is EXACT volume: count * vox^3 (image units ~ metres) in cm3.

create or replace function public.place_voxels(
  p_spot_id  uuid,
  p_lat      double precision,
  p_lon      double precision,
  p_accuracy double precision,
  p_cells    jsonb,
  p_vox      double precision,
  p_depth    double precision default 0
) returns public.tags
language plpgsql security definer set search_path = public as $$
declare
  v_n    int;
  v_cost numeric;
  v_size text;
  v_tag  public.tags;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.spots where id = p_spot_id and status = 'active') then
    raise exception 'spot not found';
  end if;

  v_n := jsonb_array_length(p_cells);
  if v_n < 1 or v_n > 4000 then raise exception 'invalid voxel count'; end if;
  if p_vox is null or p_vox <= 0.004 or p_vox > 0.08 then
    raise exception 'invalid voxel size';
  end if;

  v_cost := greatest(10, round(v_n * power(p_vox, 3) * 1e6));
  v_size := case when p_vox <= 0.015 then 's' when p_vox <= 0.03 then 'm' else 'l' end;

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
     jsonb_build_object('placed_via', 'voxel-web'),
     p_spot_id,
     jsonb_build_object('cells', p_cells, 'vox', p_vox, 'z',
       least(greatest(coalesce(p_depth, 0), -0.15), 0.3)))
  returning * into v_tag;

  update public.profiles set used_volume = used_volume + v_cost where id = auth.uid();
  return v_tag;
end $$;

grant execute on function public.place_voxels to authenticated;
