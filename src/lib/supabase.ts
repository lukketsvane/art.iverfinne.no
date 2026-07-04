import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

let client: SupabaseClient | null = null;

// Baked-in project defaults. Both values are public by design — the
// publishable key ships in every client bundle and RLS is the security
// boundary. Env vars (when present at build time) still override.
const DEFAULT_URL = 'https://owpyqzcpitvzeozcfiaw.supabase.co';
const DEFAULT_KEY = 'sb_publishable_3pt3SBJRxrILlkfBxtn55Q_XXVski3n';

// New Supabase projects issue sb_publishable_... keys; older ones a JWT "anon"
// key. Either works with supabase-js — accept both env names.
function publicKey(): string {
	return env.PUBLIC_SUPABASE_ANON_KEY || env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY;
}

function projectUrl(): string {
	return env.PUBLIC_SUPABASE_URL || DEFAULT_URL;
}

export function isConfigured(): boolean {
	return Boolean(projectUrl() && publicKey());
}

export function supabase(): SupabaseClient {
	if (!client) {
		client = createClient(projectUrl(), publicKey());
	}
	return client;
}

/** Jodel-style: silently create an anonymous account on first launch. */
export async function ensureSession(): Promise<string> {
	const sb = supabase();
	const { data } = await sb.auth.getSession();
	if (data.session) return data.session.user.id;
	const { data: anon, error } = await sb.auth.signInAnonymously();
	if (error || !anon.session) throw error ?? new Error('anonymous sign-in failed');
	return anon.session.user.id;
}
