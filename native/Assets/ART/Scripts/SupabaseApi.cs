using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Art
{
    /// <summary>
    /// Minimal Supabase client: anonymous GoTrue session + PostgREST RPCs.
    /// No external SDK — UnityWebRequest + JsonUtility only.
    /// </summary>
    public class SupabaseApi : MonoBehaviour
    {
        public static SupabaseApi Instance { get; private set; }

        public string AccessToken { get; private set; }
        public string UserId { get; private set; }
        public bool IsSignedIn => !string.IsNullOrEmpty(AccessToken);

        private void Awake()
        {
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        // ---- Auth -----------------------------------------------------------

        [Serializable] private class AuthResponse
        {
            public string access_token;
            public string refresh_token;
            public AuthUser user;
        }
        [Serializable] private class AuthUser { public string id; }

        /// <summary>Anonymous sign-in (requires the Anonymous provider enabled).</summary>
        public IEnumerator SignInAnonymously(Action<bool, string> done)
        {
            var refresh = PlayerPrefs.GetString("art_refresh", null);
            if (!string.IsNullOrEmpty(refresh))
            {
                yield return Post($"{ArtConfig.SupabaseUrl}/auth/v1/token?grant_type=refresh_token",
                    "{\"refresh_token\":\"" + refresh + "\"}", false,
                    (ok, body) => { if (ok) ApplyAuth(body); });
                if (IsSignedIn) { done(true, null); yield break; }
            }

            yield return Post($"{ArtConfig.SupabaseUrl}/auth/v1/signup", "{}", false,
                (ok, body) =>
                {
                    if (ok) { ApplyAuth(body); done(true, null); }
                    else done(false, body);
                });
        }

        private void ApplyAuth(string json)
        {
            var res = JsonUtility.FromJson<AuthResponse>(json);
            if (res == null || string.IsNullOrEmpty(res.access_token)) return;
            AccessToken = res.access_token;
            UserId = res.user != null ? res.user.id : null;
            PlayerPrefs.SetString("art_refresh", res.refresh_token ?? "");
            PlayerPrefs.Save();
        }

        // ---- RPC ------------------------------------------------------------

        /// <summary>POST /rest/v1/rpc/{fn}. Response body handed back raw.</summary>
        public IEnumerator Rpc(string fn, string jsonArgs, Action<bool, string> done)
        {
            yield return Post($"{ArtConfig.SupabaseUrl}/rest/v1/rpc/{fn}", jsonArgs, true, done);
        }

        private IEnumerator Post(string url, string json, bool bearer, Action<bool, string> done)
        {
            using var req = new UnityWebRequest(url, "POST");
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("apikey", ArtConfig.SupabaseKey);
            req.SetRequestHeader("Authorization",
                "Bearer " + (bearer && IsSignedIn ? AccessToken : ArtConfig.SupabaseKey));
            yield return req.SendWebRequest();
            done(req.result == UnityWebRequest.Result.Success, req.downloadHandler.text);
        }
    }

    /// <summary>JsonUtility can't parse top-level arrays; wrap them.</summary>
    public static class JsonArray
    {
        public static T[] Parse<T>(string json)
        {
            var wrapped = "{\"items\":" + json + "}";
            return JsonUtility.FromJson<Wrapper<T>>(wrapped).items;
        }
        [Serializable] private class Wrapper<T> { public T[] items; }
    }
}
