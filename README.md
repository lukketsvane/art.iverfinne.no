# ART — AR Tagging · iOS Web MVP

"Jodel meets AR." Place 3D tags (models/stickers) at real-world locations; others nearby
see and appraise them. Appraisals grow the creator's placement volume ("spray can").

**This is the sensor-AR web MVP**: camera feed + GPS + compass overlay via
[LocAR.js](https://github.com/AR-js-org/locar.js). iOS Safari has no WebXR, so content
drifts within GPS accuracy (~5–15 m) — accepted for validating the social loop.
Full pose data (lat/lon/alt/heading/accuracy) is logged on every placement so content
migrates cleanly to the native + VPS version (v2). See `FEASIBILITY-2026.md` and
`docs/BRIEF.md` for the full background.

## Stack

- **SvelteKit 2 + Svelte 5** (TypeScript), SPA via `adapter-static`, installable PWA
- **Three.js + LocAR.js** for the AR view (getUserMedia + DeviceOrientation + GPS)
- **Supabase**: Postgres + PostGIS, anonymous auth, RPCs for all game logic
- Hosting: any static host (Cloudflare Pages / Vercel) + Supabase cloud

## Setup

1. **Supabase project** — create one at [database.new](https://database.new), then:
   - Enable anonymous sign-in: Dashboard → Authentication → Providers → **Anonymous**.
   - Apply the migration: paste `supabase/migrations/0001_init.sql` into the SQL editor
     (or `supabase link && supabase db push` with the CLI).
2. **Env** — `cp .env.example .env`, fill in `PUBLIC_SUPABASE_URL` and
   `PUBLIC_SUPABASE_ANON_KEY` (Settings → API).
3. **Run**
   ```sh
   npm install
   npm run dev            # desktop dev (use fakeGps / devtools sensor emulation)
   npm run dev:https      # LAN HTTPS — required to test on a real iPhone
   ```
   On iPhone: open `https://<your-lan-ip>:5173`, accept the self-signed cert,
   grant camera + location + motion access.

## How it works

- `src/lib/ar/session.ts` — wraps LocAR's `App`: camera feed, orientation controls
  (incl. the iOS motion-permission dialog), GPS events, tap raycasting, tag meshes.
- `src/lib/library.ts` — curated zero-asset content library (canvas-texture stickers,
  procedural models). `model_url` is `builtin:<id>`; GLB URLs can join later.
- `src/lib/api.ts` — thin RPC client: `nearby_tags`, `place_tag`, `appraise_tag`, `report_tag`.
- `supabase/migrations/0001_init.sql` — schema + RLS + all game logic:
  - `place_tag` atomically checks remaining volume (row lock), inserts, debits.
  - `appraise_tag` enforces one-per-user, blocks self-appraisal, credits +25 cm³.
  - `nearby_tags` is `ST_DWithin` over a GIST index on `geography(PointZ)`.
  - Direct table writes are impossible (no insert policies) — RPCs are the only door.

## Economy constants

| Thing | Value |
|---|---|
| Signup grant | 500 cm³ |
| Tag cost S / M / L | 50 / 125 / 250 cm³ |
| Appraisal credit to creator | +25 cm³ |
| Auto-hide after reports | 3 |

## Definition of done (MVP)

Place a tag at your location → another iPhone within radius sees it in camera view →
appraise it → creator's volume increases → volume limit blocks over-placement.

## Known limits (by design, see docs/BRIEF.md)

- GPS drift: tags float and shift by metres; rendered at eye level (alt logged, not used).
- Curated library only — no user 3D uploads in MVP.
- Polling (30 s / 20 m moved), no realtime subscriptions.
- Camera permission is re-prompted each Safari session; install to Home Screen to soften.
