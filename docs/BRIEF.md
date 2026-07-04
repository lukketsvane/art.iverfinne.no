# ART — iOS Web MVP · Tech Brief (v2, July 2026)

**Product:** "Jodel meets AR." Users place 3D tags (models/stickers) at real-world
locations; others nearby see and appraise them. Appraisals grow the creator's
placement volume ("spray can").

## Constraint — read first

iOS Safari has **no WebXR**. This MVP is **sensor AR**: camera feed + GPS + compass
overlay, ~5–15 m accuracy. Content will drift/float — that's accepted. Goal is
validating the social loop, not wall-precise graffiti (that's v2, native + VPS).
Log full pose data now so content migrates cleanly.

> Historical note: the v1 brief targeted Niantic Studio (8th Wall) + Lightship VPS for
> Web. That platform shut down 2026-02-28 (hosted content dies 2027-02-28); the
> open-source engine release excludes SLAM and VPS. Remaining web-VPS options
> (Zappar Mattercraft + Immersal/MultiSet) are paid, enterprise-leaning, and need
> per-location scans — wrong fit for a free consumer MVP. Hence sensor AR now,
> native + VPS later.

## Stack

**Frontend — PWA**
- SvelteKit 2 + Svelte 5, TypeScript
- Three.js + **LocAR.js** (geolocation AR: getUserMedia camera, DeviceOrientation + GPS)
- Assets: GLB only, compressed (MVP ships zero assets — builtin procedural library)
- vite-plugin-pwa (installable). HTTPS everywhere. DeviceOrientation permission is
  user-gesture-gated on iOS (LocAR's built-in dialog handles it)

**Backend — Supabase (hosted, free tier)**
- Postgres + **PostGIS**: `tags` with `geography(PointZ, 4326)` + GIST; `ST_DWithin`
- **Postgres RPCs** for atomic game logic: `place_tag`, `appraise_tag`, `nearby_tags`, `report_tag`
- Supabase Auth — **anonymous sign-in**; Sign in with Apple later
- Supabase Storage + CDN for GLBs when user uploads arrive (post-MVP)
- **Polling on location change** (no realtime subscriptions in MVP)

**Hosting** — Cloudflare Pages / Vercel (static SPA) + Supabase cloud

## Data model (implemented in `supabase/migrations/0001_init.sql`)

- `profiles`: id, handle, total_volume (500 signup grant), used_volume
- `tags`: id, creator_id, `geog geography(PointZ)`, heading, accuracy_m, model_url,
  size_class (s/m/l → 50/125/250 cm³), volume_cm3, status, device_meta, created_at
- `appraisals`: (tag_id, user_id) PK — one per user per tag; +25 cm³ to creator
- `reports`: 3 reports auto-hide a tag

## Guardrails & decisions

1. **Pose logging:** lat/lon/**altitude** + heading + accuracy on every tag — required
   for v2 VPS migration.
2. **Asset budget:** GLB ≤ 2–5 MB; lazy-load by proximity; cap ~20 visible tags.
3. **Model source (MVP):** curated sticker/model library only — no user 3D uploads.
4. **Optional precision upgrade:** Variant Launch SDK (paid) wraps WebXR in an iOS App
   Clip → true world-locked tracking, still no global VPS. Decide after sensor-AR testing.
5. **Moderation stub:** report button + soft-hide from day one.

## MVP definition of done

Place a tag at your location → another iPhone within radius sees it in camera view →
appraise it → creator's volume increases → volume limit blocks over-placement.
