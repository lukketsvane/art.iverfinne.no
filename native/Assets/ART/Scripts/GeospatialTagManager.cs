using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
using Google.XR.ARCoreExtensions;

namespace Art
{
    /// <summary>
    /// The core loop: wait for VPS localization, mirror nearby_tags as
    /// Geospatial anchors, place new tags from the camera's GeospatialPose.
    /// All Geospatial API calls live in this one file on purpose — if the
    /// ARCore Extensions API surface drifts, this is the only file to touch.
    /// </summary>
    public class GeospatialTagManager : MonoBehaviour
    {
        public AREarthManager earthManager;
        public ARAnchorManager anchorManager;
        public Camera arCamera;

        public string Status { get; private set; } = "starting";
        public double HorizontalAccuracy { get; private set; } = double.NaN;
        public double YawAccuracy { get; private set; } = double.NaN;
        public bool Localized { get; private set; }
        public double TotalVolume { get; private set; }
        public double UsedVolume { get; private set; }
        public string SelectedModel = "builtin:arttag";
        public string SelectedSize = "m";

        private readonly Dictionary<string, GameObject> _spawned = new();
        private double _lastFetchLat = double.NaN, _lastFetchLon = double.NaN;
        private float _lastFetchTime = -999f;

        [Serializable] public class TagRow
        {
            public string id;
            public string creator_id;
            public double lat, lon, alt;
            public string model_url;
            public string size_class;
            public long appraisals;
            public bool appraised;
            public GeoQuat geo_quat;
        }
        [Serializable] public class GeoQuat { public float x, y, z, w; }
        [Serializable] private class ProfileRow
        {
            public string id; public double total_volume; public double used_volume;
        }

        private IEnumerator Start()
        {
            Status = "signing in";
            var api = SupabaseApi.Instance;
            bool authOk = false;
            yield return api.SignInAnonymously((ok, err) => authOk = ok);
            if (!authOk) { Status = "auth failed — anonymous provider on?"; yield break; }

            yield return RefreshProfile();
            Status = "waiting for AR session";

            while (true)
            {
                yield return null;

                if (ARSession.state != ARSessionState.SessionTracking) continue;
                if (earthManager.EarthState != EarthState.Enabled) { Status = "earth: " + earthManager.EarthState; continue; }

                var tracking = earthManager.EarthTrackingState == TrackingState.Tracking;
                if (!tracking) { Status = "localizing against VPS…"; Localized = false; continue; }

                var pose = earthManager.CameraGeospatialPose;
                HorizontalAccuracy = pose.HorizontalAccuracy;
                YawAccuracy = pose.OrientationYawAccuracy;
                Localized = pose.HorizontalAccuracy <= ArtConfig.MaxHorizontalAccuracyM
                         && pose.OrientationYawAccuracy <= ArtConfig.MaxOrientationYawAccuracyDeg;
                Status = Localized
                    ? $"locked ±{pose.HorizontalAccuracy:0.0}m / ±{pose.OrientationYawAccuracy:0.0}°"
                    : $"refining ±{pose.HorizontalAccuracy:0.0}m / ±{pose.OrientationYawAccuracy:0.0}°";

                var moved = double.IsNaN(_lastFetchLat) ? double.MaxValue
                    : Haversine(pose.Latitude, pose.Longitude, _lastFetchLat, _lastFetchLon);
                if (moved > ArtConfig.RefetchDistanceM ||
                    Time.time - _lastFetchTime > ArtConfig.RefetchIntervalS)
                {
                    _lastFetchTime = Time.time;
                    _lastFetchLat = pose.Latitude;
                    _lastFetchLon = pose.Longitude;
                    StartCoroutine(FetchNearby(pose.Latitude, pose.Longitude));
                }
            }
        }

        private IEnumerator FetchNearby(double lat, double lon)
        {
            var args = string.Format(CultureInfo.InvariantCulture,
                "{{\"p_lat\":{0},\"p_lon\":{1},\"p_radius_m\":{2}}}",
                lat, lon, ArtConfig.FetchRadiusM);
            string body = null; bool ok = false;
            yield return SupabaseApi.Instance.Rpc("nearby_tags", args, (o, b) => { ok = o; body = b; });
            if (!ok) yield break;

            foreach (var row in JsonArray.Parse<TagRow>(body))
            {
                if (_spawned.ContainsKey(row.id)) continue;
                SpawnAnchored(row);
            }
        }

        private void SpawnAnchored(TagRow row)
        {
            // EUS quaternion when the tag was placed natively; heading-derived
            // yaw (or identity) for web tags.
            var rotation = row.geo_quat != null && row.geo_quat.w != 0
                ? new Quaternion(row.geo_quat.x, row.geo_quat.y, row.geo_quat.z, row.geo_quat.w)
                : Quaternion.identity;

            // Terrain anchor when altitude is unknown/zero (web tags), WGS84
            // anchor when native placed it with a real altitude.
            ARGeospatialAnchor anchor = Math.Abs(row.alt) < 0.01
                ? anchorManager.ResolveAnchorOnTerrain(row.lat, row.lon, 1.2, rotation)
                : anchorManager.AddAnchor(row.lat, row.lon, row.alt, rotation);
            if (anchor == null) return;

            var visual = TagVisuals.Build(row.model_url, row.size_class);
            visual.transform.SetParent(anchor.transform, false);
            var meta = visual.AddComponent<TagMeta>();
            meta.tagId = row.id;
            meta.creatorId = row.creator_id;
            meta.appraised = row.appraised;
            _spawned[row.id] = anchor.gameObject;
        }

        /// <summary>Place the selected builtin 2 m ahead at the camera's geopose.</summary>
        public void PlaceHere()
        {
            if (!Localized) return;
            StartCoroutine(PlaceRoutine());
        }

        private IEnumerator PlaceRoutine()
        {
            var camPose = earthManager.CameraGeospatialPose;
            // Convert "2 m ahead of the camera" into a geopose by asking the
            // Geospatial API for the pose of that world-space point.
            var ahead = arCamera.transform.position + arCamera.transform.forward * ArtConfig.PlaceAheadM;
            var aheadPose = earthManager.Convert(new Pose(ahead, arCamera.transform.rotation));

            var q = aheadPose.EunRotation;
            var args = string.Format(CultureInfo.InvariantCulture,
                "{{\"p_lat\":{0},\"p_lon\":{1},\"p_alt\":{2},\"p_heading\":{3},\"p_accuracy\":{4}," +
                "\"p_model_url\":\"{5}\",\"p_size_class\":\"{6}\"," +
                "\"p_device\":{{\"placed_via\":\"native-geospatial\"}}," +
                "\"p_geo_quat\":{{\"x\":{7},\"y\":{8},\"z\":{9},\"w\":{10}}}}}",
                aheadPose.Latitude, aheadPose.Longitude, aheadPose.Altitude,
                camPose.Heading, camPose.HorizontalAccuracy,
                SelectedModel, SelectedSize,
                q.x, q.y, q.z, q.w);

            string body = null; bool ok = false;
            yield return SupabaseApi.Instance.Rpc("place_tag", args, (o, b) => { ok = o; body = b; });
            if (!ok) { Status = body != null && body.Contains("insufficient") ? "spray can empty!" : "place failed"; yield break; }

            var row = JsonUtility.FromJson<TagRow>(body);
            row.lat = aheadPose.Latitude; row.lon = aheadPose.Longitude; row.alt = aheadPose.Altitude;
            SpawnAnchored(row);
            yield return RefreshProfile();
        }

        /// <summary>Screen-tap appraisal.</summary>
        public void TapAt(Vector2 screenPos)
        {
            var ray = arCamera.ScreenPointToRay(screenPos);
            if (!Physics.Raycast(ray, out var hit, 100f)) return;
            var meta = hit.transform.GetComponentInParent<TagMeta>();
            if (meta == null || meta.appraised || meta.creatorId == SupabaseApi.Instance.UserId) return;
            StartCoroutine(Appraise(meta));
        }

        private IEnumerator Appraise(TagMeta meta)
        {
            bool ok = false;
            yield return SupabaseApi.Instance.Rpc("appraise_tag",
                "{\"p_tag_id\":\"" + meta.tagId + "\"}", (o, _) => ok = o);
            if (ok) { meta.appraised = true; Status = "appraised +25 cm³"; }
        }

        private IEnumerator RefreshProfile()
        {
            // PostgREST row fetch via RPC-free endpoint would need more plumbing;
            // the profiles table is readable, use a filtered select.
            using var req = UnityEngine.Networking.UnityWebRequest.Get(
                $"{ArtConfig.SupabaseUrl}/rest/v1/profiles?id=eq.{SupabaseApi.Instance.UserId}&select=id,total_volume,used_volume");
            req.SetRequestHeader("apikey", ArtConfig.SupabaseKey);
            req.SetRequestHeader("Authorization", "Bearer " + SupabaseApi.Instance.AccessToken);
            yield return req.SendWebRequest();
            if (req.result != UnityEngine.Networking.UnityWebRequest.Result.Success) yield break;
            var rows = JsonArray.Parse<ProfileRow>(req.downloadHandler.text);
            if (rows.Length > 0) { TotalVolume = rows[0].total_volume; UsedVolume = rows[0].used_volume; }
        }

        private static double Haversine(double lat1, double lon1, double lat2, double lon2)
        {
            const double R = 6371000;
            double dLat = (lat2 - lat1) * Math.PI / 180;
            double dLon = (lon2 - lon1) * Math.PI / 180;
            double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                       Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) *
                       Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
            return 2 * R * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
        }
    }

    public class TagMeta : MonoBehaviour
    {
        public string tagId;
        public string creatorId;
        public bool appraised;
    }
}
