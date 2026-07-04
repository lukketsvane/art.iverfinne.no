# ART (AR Tagging) — Feasibility Re-evaluation, July 2026

> "Jodel meets AR" — geolocated, persistent, user-placed 3D content (models, stickers, paint),
> volume-limited per user, with appraisals that grow the creator's volume.

## Verdict

**Buildable now.** The core loop — place a 3D object at a real-world location on one phone,
see it in the same place on another phone — is a solved problem in 2026 via the ARCore
Geospatial API, on both Android **and iOS**, for free, with no self-hosted VPS.
The three hard requirements from the original spec map directly onto shipped tech:

| Requirement (original spec) | 2026 answer |
|---|---|
| 1. Geostatisk koordinatsystem — global coords aligning virtual content across devices | ARCore **Geospatial anchors** (WGS84 lat/lng/alt + quaternion). Google's VPS localizes the phone against Street View imagery; no per-location scanning needed. Terrain and Rooftop anchors resolve altitude automatically. |
| 2. Sanntidssynkronisering — fast, reliable sync of placement data | Ordinary backend problem, not an AR problem. Postgres + PostGIS with realtime subscriptions (e.g. Supabase) handles geo-indexed fetch + live updates trivially at this scale. |
| 3. Konsistens mellom einingar — consistent rendering across devices/ARKit versions | Solved by building on **Unity 6 + AR Foundation + ARCore Extensions**: one codebase, one renderer, ARKit/ARCore differences abstracted away. Geospatial accuracy in VPS-covered areas is sub-meter position, ~degree orientation — good enough for street-level tagging. |

What was *not* feasible a year ago and still isn't: **web-delivered AR on iOS**. Safari still
does not ship WebXR `immersive-ar` on iPhone, and 8th Wall — the main workaround — shut down
in February 2026. The conclusion flips from "wait" to "go native (via Unity), skip the web client."

## What changed since mid-2025

**Got better:**
- **ARCore Geospatial API matured.** Streetscape Geometry (LOD2 building meshes within 100 m)
  gives real-world occlusion and surface snapping for "paint on that wall" interactions.
  Geospatial Depth extends depth to 65 m in VPS areas. iOS SDK still actively maintained
  (releases through Nov 2025). The API remains free.
- **Gaussian splatting went mainstream.** The capture→process→view pipeline is now commodity:
  phone video → splat, with mature editors (SuperSplat) and web/Unity renderers (Spark,
  GaussianSplats3D). This is the realistic implementation of the "scan and place 3D models"
  feature — in 2025 it was research-grade.
- **Android XR unification.** ARCore is being folded into Jetpack XR with mobile support,
  meaning the phone-AR investment carries forward to headsets rather than dead-ending.

**Got worse / consolidated:**
- **8th Wall shut down** (access ended Feb 2026). WebAR as a primary platform is off the table.
- **Niantic pivoted to enterprise.** Lightship.dev is being decommissioned (Feb 2026 → NSDK 4.0 /
  Scaniverse platform). Their VPS (1M+ locations) still exists but is now an enterprise product —
  a fallback option, not the default.
- **iOS WebXR AR: still nothing.** visionOS Safari got WebXR (VR only); iPhone Safari did not.

## Recommended architecture

```
Unity 6 client (iOS + Android)
  AR Foundation + ARCore Extensions (Geospatial API)
  ├─ localize via VPS → GeospatialPose
  ├─ place: GeospatialAnchor / TerrainAnchor / RooftopAnchor
  ├─ occlusion: Streetscape Geometry + Geospatial Depth
  └─ fetch nearby content by geohash tile as user moves

Backend: Supabase (or equivalent)
  ├─ Postgres + PostGIS: placements(lat, lng, alt, quat, asset_id, owner, …)
  │    nearby query = ST_DWithin on a spatial index
  ├─ Realtime: subscribe to the geohash tiles around the user
  ├─ Storage: GLB / .splat / sticker textures, CDN-served
  ├─ Auth: anonymous-first (Jodel-style), device-bound
  └─ Volume ledger: placements debit voxel-volume from the user's "can";
     appraisals credit the creator's total volume. Plain transactional SQL.

Scanning pipeline (phase 3)
  iOS: RealityKit Object Capture (on-device photogrammetry → USDZ/GLB)
  Cross-platform: video → Gaussian splat (Scaniverse/Luma-style) → splat renderer in Unity
```

**Why not native Swift/Kotlin twice:** the Geospatial API is Google's and its first-class
cross-platform surface is Unity/AR Foundation. One solo-maintainable codebase beats two.

**Why not Niantic:** enterprise pricing/migration churn, and their VPS needs per-location scans;
Google's rides on existing Street View — which covers Norwegian cities well. Verify per-launch-area
with `CheckVpsAvailability()`.

## Remaining risks (honest list)

1. **VPS coverage gaps** — indoors and off-street there is no VPS; raw GPS+compass fallback is
   1–5 m / tens of degrees. Mitigation: MVP is outdoor-city-only (fits the Jodel model);
   ARCore Cloud Anchors (365-day persistence) for indoor/precision spots later.
2. **Platform risk on iOS** — Google maintains ARCore-iOS today, but their center of gravity is
   Android XR. If they ever drop iOS, fallback is ARKit GeoTracking (Apple's own, but city-list
   limited and weak in Norway) or Niantic VPS. Watch, don't block on it.
3. **Cold start / empty world** — the classic geosocial failure mode, and the real risk now that
   tech isn't. Launch in one city, seed content, keep the map view usable without AR.
4. **Moderation & GDPR** — user content pinned to physical places (homes, schools) needs
   report/takedown, exclusion zones, and location-data care from day one.
5. **Battery/thermals** — continuous VPS + rendering is heavy; aim AR sessions at minutes,
   with the map as the browsing surface.

## Phased plan

**Phase 0 — Feasibility spike (1–2 weeks).** Unity 6 + AR Foundation + ARCore Extensions
Geospatial sample. Place a cube on a street in Oslo from phone A; find it with phone B the next
day. Measure drift. *This single test retires the risk that killed the project in 2025.*
Kill criterion: if cross-device error is worse than ~1 m in VPS-covered areas, stop and reassess.

**Phase 1 — Core loop (4–6 weeks).** Anonymous auth; sticker/model library; place & persist
(PostGIS); nearby fetch by geohash tile; minimal map view; other users' content renders in AR.

**Phase 2 — The economy (3–4 weeks).** Volume "can" (placement debits by bounding-volume),
appraisals (free, credit creator volume), delete/decay of unappraised content, report/moderation.

**Phase 3 — Scanning (4+ weeks).** iOS Object Capture first (on-device, ships USDZ/GLB);
splat capture pipeline cross-platform second. Paint tool (polyline strokes stored anchor-relative,
snapped to Streetscape Geometry surfaces).

**Phase 4 — Polish/scale.** Occlusion everywhere, LOD/streaming, content decay rules,
second city.

## Cost to validate

Geospatial API: free. Unity personal: free at this scale. Supabase: free tier.
Hardware: the phones already in your pocket. **Phase 0 costs ~zero kroner and two weeks.**

## Sources

- [ARCore Geospatial API](https://developers.google.com/ar/develop/geospatial) · [Streetscape Geometry](https://developers.google.com/ar/develop/unity-arf/geospatial/streetscape-geometry) · [Geospatial Depth](https://developers.google.com/ar/develop/unity-arf/depth/geospatial-depth)
- [ARCore iOS SDK (active releases)](https://github.com/google-ar/arcore-ios-sdk/releases) · [Geospatial on iOS](https://developers.google.com/ar/develop/ios/geospatial/enable)
- [ARCore for Jetpack XR — mobile](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/mobile)
- [Niantic Spatial platform / NSDK migration](https://www.nianticspatial.com/docs/nsdk/migration_guide/) · [Niantic Spatial announcement](https://nianticlabs.com/news/nianticspatial)
- [8th Wall shutdown timeline](https://ar-code.com/blog/8th-wall-is-shutting-down-timeline-impact-and-the-best-8th-wall-alternative-for-webar)
- [State of WebXR on iOS](https://launch.variant3d.com/blog/23-06-state-webxr-on-ios-beyond) · [Safari 26.2 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes)
- [Spark — 3DGS renderer for three.js](https://www.worldlabs.ai/blog/spark-2.0) · [State of Gaussian splatting 2026](https://www.thefuture3d.com/blog/state-of-gaussian-splatting-2026/)
