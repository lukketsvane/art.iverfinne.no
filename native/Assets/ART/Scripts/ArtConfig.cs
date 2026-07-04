namespace Art
{
    /// <summary>Endpoints + tuning. Same Supabase project as the web app.</summary>
    public static class ArtConfig
    {
        // Both values are public by design (RLS is the security boundary).
        public const string SupabaseUrl = "https://owpyqzcpitvzeozcfiaw.supabase.co";
        public const string SupabaseKey = "sb_publishable_3pt3SBJRxrILlkfBxtn55Q_XXVski3n";

        public const float FetchRadiusM = 150f;
        public const float RefetchDistanceM = 20f;
        public const float RefetchIntervalS = 30f;
        public const float PlaceAheadM = 2f;

        // Don't place until Geospatial pose is at least this good.
        public const double MaxHorizontalAccuracyM = 5.0;
        public const double MaxOrientationYawAccuracyDeg = 15.0;
    }
}
