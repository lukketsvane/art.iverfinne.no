# ART native — seamless cm-precision everywhere

Unity 6 + AR Foundation + **ARCore Geospatial API**: global, centimetre-class,
shared placement wherever Google VPS has coverage (all Norwegian cities — it
rides on Street View imagery). Same Supabase backend as the web app: one world,
two clients. Web tags appear in native and vice versa; native tags carry a full
EUS orientation quaternion (`geo_quat`), web tags fall back to heading-only.

## Prerequisites

- Unity 6 LTS (6000.x) with iOS and/or Android build support modules
- A Google Cloud project with the **ARCore API** enabled
  (Console → APIs & Services → enable "ARCore API" → create an API key)
- iOS builds: macOS + Xcode + CocoaPods; Android builds: nothing extra
- Supabase migrations `0001`–`0004` applied

## Setup (once)

1. Unity Hub → New project → **3D (Built-in)** → name it anything → replace the
   generated `Packages/manifest.json` with the one in this folder, and copy
   `Assets/ART` into the project's `Assets/`. (Or open this `native/` folder
   directly as a project — Unity will generate the missing ProjectSettings.)
2. Wait for packages to resolve (ARCore Extensions pulls from GitHub).
3. **Project Settings → XR Plug-in Management**: enable ARCore (Android) and/or
   ARKit (iOS). Under the **ARCore Extensions** entry: paste your ARCore API
   key in the Android/iOS API-key fields and tick **Geospatial**.
4. Edit `Assets/ART/Scripts/ArtConfig.cs` — set your Supabase URL + publishable
   key (same values as the web app).
5. Menu bar → **ART → Build Scene** — creates and saves `Assets/ART/ART.unity`
   with the full object graph (ARSession, XR Origin, AREarthManager, managers).
6. File → Build Settings → add `ART.unity` → switch platform → Build & Run.
   - iOS: set a bundle id + signing team; ARKit requires a real device.
   - Add camera + location usage descriptions when prompted (the scene builder
     sets sensible defaults in ProjectSettings where it can).

## What the app does (MVP parity with web)

- Anonymous Supabase session, profile + spray-can volume
- Waits for VPS localization (`AREarthManager.EarthTrackingState`), shows
  horizontal/orientation accuracy live in the HUD
- Fetches `nearby_tags` and resolves each as a **Geospatial anchor**
  (lat/lon/alt + `geo_quat` when present) — content is world-locked, shared,
  and does not drift like web sensor AR
- Place: spawns the selected builtin model 2 m ahead, reads the camera's
  `GeospatialPose`, stores WGS84 + EUS quaternion via `place_tag`
- Tap a tag to appraise (+25 cm³ to its creator)

## Files

- `Packages/manifest.json` — AR Foundation 6, ARCore/ARKit XR plugins,
  ARCore Extensions (Geospatial)
- `Assets/ART/Scripts/ArtConfig.cs` — endpoints + tuning constants
- `Assets/ART/Scripts/SupabaseApi.cs` — anonymous auth + RPC client
  (UnityWebRequest; no external SDK)
- `Assets/ART/Scripts/GeospatialTagManager.cs` — localization gate, anchor
  resolution, placement, appraisal raycasts
- `Assets/ART/Scripts/TagVisuals.cs` — builtin content (matches web library ids)
- `Assets/ART/Scripts/ArtHud.cs` — minimal IMGUI HUD (no scene wiring needed)
- `Assets/ART/Editor/ArtSceneBuilder.cs` — "ART → Build Scene" menu command

## Reality checks

- VPS coverage: query `AREarthManager.CheckVpsAvailability(lat, lon)` — the HUD
  shows it. Outside coverage the app still tracks but with GPS-grade accuracy.
- The Geospatial API is free; quota is generous (localization is on-device
  against downloaded VPS tiles; only tile fetches hit Google).
- API surface drifts between ARCore Extensions versions; if a call doesn't
  compile, check the migration notes in the package changelog — the manager
  script isolates all Geospatial calls in one file on purpose.
