import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

let client: SupabaseClient | null = null;

export function isConfigured(): boolean {
	return Boolean(env.PUBLIC_SUPABASE_URL && env.PUBLIC_SUPABASE_ANON_KEY);
}

export function supabase(): SupabaseClient {
	if (!client) {
		if (!isConfigured()) {
			throw new Error('Supabase is not configured — copy .env.example to .env');
		}
		client = createClient(env.PUBLIC_SUPABASE_URL!, env.PUBLIC_SUPABASE_ANON_KEY!);
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
