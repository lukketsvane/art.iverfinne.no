import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA: no server routes — all data access goes through Supabase RPCs.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
