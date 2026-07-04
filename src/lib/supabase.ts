import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

let client: SupabaseClient | null = null;

// New Supabase projects issue sb_publishable_... keys; older ones a JWT "anon"
// key. Either works with supabase-js — accept both env names.
function publicKey(): string | undefined {
	return env.PUBLIC_SUPABASE_ANON_KEY || env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
}

export function isConfigured(): boolean {
	return Boolean(env.PUBLIC_SUPABASE_URL && publicKey());
}

export function supabase(): SupabaseClient {
	if (!client) {
		if (!isConfigured()) {
			throw new Error('Supabase is not configured — copy .env.example to .env');
		}
		client = createClient(env.PUBLIC_SUPABASE_URL!, publicKey()!);
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
