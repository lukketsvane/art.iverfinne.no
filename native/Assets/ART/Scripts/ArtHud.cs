using UnityEngine;

namespace Art
{
    /// <summary>
    /// Deliberately scene-free IMGUI HUD so the scaffold needs zero prefab
    /// wiring: status line, can meter, library picker, PLACE button, and
    /// tap-to-appraise forwarding.
    /// </summary>
    public class ArtHud : MonoBehaviour
    {
        public GeospatialTagManager manager;

        private int _libIndex = 4; // arttag
        private int _sizeIndex = 1; // m
        private static readonly string[] Sizes = { "s", "m", "l" };

        private void Update()
        {
            if (Input.touchCount == 1 && Input.GetTouch(0).phase == TouchPhase.Began)
            {
                var t = Input.GetTouch(0);
                if (t.position.y > Screen.height * 0.25f) // above the HUD band
                    manager.TapAt(t.position);
            }
        }

        private void OnGUI()
        {
            var w = Screen.width;
            var h = Screen.height;
            GUI.skin.label.fontSize = (int)(h * 0.02f);
            GUI.skin.button.fontSize = (int)(h * 0.022f);

            var remaining = manager.TotalVolume - manager.UsedVolume;
            GUI.Label(new Rect(20, 30, w - 40, 40), $"ART · {manager.Status}");
            GUI.Label(new Rect(20, 70, w - 40, 40), $"🧯 {remaining:0} cm³");

            var band = h * 0.25f;
            var y = h - band;

            for (int i = 0; i < TagVisuals.LibraryIds.Length; i++)
            {
                var r = new Rect(10 + i * (w - 20) / 8f, y, (w - 20) / 8f - 4, band * 0.3f);
                var sel = i == _libIndex;
                if (GUI.Button(r, (sel ? "✓" : "") + TagVisuals.LibraryIds[i])) _libIndex = i;
            }

            for (int i = 0; i < Sizes.Length; i++)
            {
                var r = new Rect(10 + i * 90, y + band * 0.35f, 80, band * 0.22f);
                var sel = i == _sizeIndex;
                if (GUI.Button(r, (sel ? "✓" : "") + Sizes[i].ToUpper())) _sizeIndex = i;
            }

            manager.SelectedModel = "builtin:" + TagVisuals.LibraryIds[_libIndex];
            manager.SelectedSize = Sizes[_sizeIndex];

            GUI.enabled = manager.Localized;
            if (GUI.Button(new Rect(10, y + band * 0.62f, w - 20, band * 0.3f),
                    manager.Localized ? "PLACE" : "waiting for VPS lock…"))
                manager.PlaceHere();
            GUI.enabled = true;
        }
    }
}
