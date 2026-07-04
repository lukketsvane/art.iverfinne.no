// SPA: everything talks to Supabase from the browser; camera/sensors are
// browser-only anyway. adapter-static serves index.html as the fallback.
export const ssr = false;
export const prerender = false;
