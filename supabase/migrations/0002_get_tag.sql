-- Fetch a single tag by id (share links / focus mode).
-- Apply like 0001: paste into the SQL editor or `supabase db push`.

create or replace function public.get_tag(p_tag_id uuid)
returns table (
  id          uuid,
  creator_id  uuid,
  lat         double precision,
  lon         double precision,
  alt         double precision,
  heading     double precision,
  accuracy_m  double precision,
  model_url   text,
  size_class  text,
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
    count(a.user_id)                as appraisals,
    bool_or(a.user_id = auth.uid()) as appraised,
    t.created_at
  from public.tags t
  left join public.appraisals a on a.tag_id = t.id
  where t.id = p_tag_id and t.status = 'active'
  group by t.id;
$$;

grant execute on function public.get_tag to authenticated, anon;
