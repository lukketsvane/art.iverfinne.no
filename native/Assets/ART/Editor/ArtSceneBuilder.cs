#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.XR.ARFoundation;
using Google.XR.ARCoreExtensions;

namespace Art.EditorTools
{
    /// <summary>
    /// "ART → Build Scene": constructs the whole AR object graph in code so
    /// the repo never has to carry brittle hand-written .unity YAML.
    /// </summary>
    public static class ArtSceneBuilder
    {
        [MenuItem("ART/Build Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // AR Session + ARCore Extensions
            var sessionGo = new GameObject("AR Session");
            var session = sessionGo.AddComponent<ARSession>();
            sessionGo.AddComponent<ARInputManager>();

            // XR Origin with AR camera
            var originGo = new GameObject("XR Origin");
            var origin = originGo.AddComponent<Unity.XR.CoreUtils.XROrigin>();
            var camOffset = new GameObject("Camera Offset");
            camOffset.transform.SetParent(originGo.transform, false);
            origin.CameraFloorOffsetObject = camOffset;

            var camGo = new GameObject("AR Camera");
            camGo.transform.SetParent(camOffset.transform, false);
            var cam = camGo.AddComponent<Camera>();
            cam.tag = "MainCamera";
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Color.black;
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 1000f;
            camGo.AddComponent<ARCameraManager>();
            camGo.AddComponent<ARCameraBackground>();
            camGo.AddComponent<UnityEngine.XR.ARFoundation.ARTrackedPoseDriver>();
            origin.Camera = cam;

            var earth = originGo.AddComponent<AREarthManager>();
            var anchors = originGo.AddComponent<ARAnchorManager>();

            var extGo = new GameObject("ARCore Extensions");
            var ext = extGo.AddComponent<ARCoreExtensions>();
            ext.Session = session;
            ext.SessionOrigin = origin;
            ext.CameraManager = camGo.GetComponent<ARCameraManager>();
            var cfg = ScriptableObject.CreateInstance<ARCoreExtensionsConfig>();
            cfg.GeospatialMode = GeospatialMode.Enabled;
            AssetDatabase.CreateAsset(cfg, "Assets/ART/ARTExtensionsConfig.asset");
            ext.ARCoreExtensionsConfig = cfg;

            // ART managers
            var artGo = new GameObject("ART");
            artGo.AddComponent<SupabaseApi>();
            var mgr = artGo.AddComponent<GeospatialTagManager>();
            mgr.earthManager = earth;
            mgr.anchorManager = anchors;
            mgr.arCamera = cam;
            var hud = artGo.AddComponent<ArtHud>();
            hud.manager = mgr;

            var light = new GameObject("Directional Light").AddComponent<Light>();
            light.type = LightType.Directional;
            light.transform.rotation = Quaternion.Euler(50, -30, 0);

            EditorSceneManager.SaveScene(scene, "Assets/ART/ART.unity");
            Debug.Log("ART scene built → Assets/ART/ART.unity. Add it to Build Settings.");
        }
    }
}
#endif
