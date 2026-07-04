-- Testing-friendly economy: everyone gets a cubic metre of caulk.
-- (1e6 cm3 ≈ 7000 medium strokes — effectively unlimited for the MVP.)

alter table public.profiles alter column total_volume set default 1000000;

update public.profiles set total_volume = greatest(total_volume, 1000000);
