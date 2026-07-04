using UnityEngine;

namespace Art
{
    /// <summary>
    /// Builtin content matching the web library's `builtin:<id>` model_urls,
    /// so both clients render the same world.
    /// </summary>
    public static class TagVisuals
    {
        public static readonly string[] LibraryIds =
            { "fire", "star", "eyes", "heart", "arttag", "cube", "orb", "knot" };

        public static float SizeScale(string sizeClass) => sizeClass switch
        {
            "s" => 0.5f, "l" => 2f, _ => 1f
        };

        public static GameObject Build(string modelUrl, string sizeClass)
        {
            var id = modelUrl != null && modelUrl.StartsWith("builtin:")
                ? modelUrl.Substring(8) : "cube";
            var go = id switch
            {
                "cube" => Primitive(PrimitiveType.Cube, new Color(0.58f, 0.20f, 0.92f), 0.7f),
                "orb"  => Primitive(PrimitiveType.Sphere, new Color(0.13f, 0.83f, 0.93f), 0.9f),
                "knot" => Primitive(PrimitiveType.Capsule, new Color(0.96f, 0.62f, 0.04f), 0.6f),
                _      => Sticker(id)
            };
            go.transform.localScale *= SizeScale(sizeClass);
            return go;
        }

        private static GameObject Primitive(PrimitiveType type, Color color, float size)
        {
            var go = GameObject.CreatePrimitive(type);
            go.transform.localScale = Vector3.one * size;
            var mat = go.GetComponent<Renderer>().material;
            mat.color = color;
            return go;
        }

        private static GameObject Sticker(string id)
        {
            var text = id switch
            {
                "fire" => "🔥", "star" => "⭐", "eyes" => "👀", "heart" => "💜",
                _ => "ART"
            };
            var go = new GameObject("sticker-" + id);
            var tm = go.AddComponent<TextMesh>();
            tm.text = text;
            tm.fontSize = 64;
            tm.characterSize = 0.02f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.color = id == "arttag" ? new Color(0.88f, 0.11f, 1f) : Color.white;
            // Face-the-viewer behaviour comes from Billboard below.
            go.AddComponent<Billboard>();
            var collider = go.AddComponent<BoxCollider>();
            collider.size = new Vector3(1f, 1f, 0.1f);
            return go;
        }
    }

    public class Billboard : MonoBehaviour
    {
        private void LateUpdate()
        {
            var cam = Camera.main;
            if (cam != null) transform.rotation =
                Quaternion.LookRotation(transform.position - cam.transform.position);
        }
    }
}
