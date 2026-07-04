import { sveltekit } from '@sveltejs/kit/vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
	plugins: [
		// iOS requires a secure context for camera + deviceorientation:
		// `npm run dev:https` serves the dev server over TLS on the LAN.
		...(mode === 'https' ? [basicSsl()] : []),
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'ART — AR Tagging',
				short_name: 'ART',
				description: 'Place AR tags in the real world. Jodel meets AR graffiti.',
				start_url: '/',
				display: 'standalone',
				background_color: '#0b0b0f',
				theme_color: '#0b0b0f',
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
				]
			},
			workbox: {
				// Never cache Supabase API traffic; cache app shell + models.
				navigateFallback: '/index.html',
				runtimeCaching: [
					{
						urlPattern: /\.(?:glb|gltf)$/,
						handler: 'CacheFirst',
						options: { cacheName: 'models', expiration: { maxEntries: 40 } }
					}
				]
			}
		})
	]
}));
