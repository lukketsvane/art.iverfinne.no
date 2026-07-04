// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {}
	const __BUILD_TS__: string;
}

declare module '$lib/vendor/mindar/mindar-image.prod.js' {
	export const Compiler: any;
	export const Controller: any;
	export const UI: any;
}

declare module '$lib/vendor/mindar/mindar-image-three.prod.js' {
	export const MindARThree: any;
}

export {};
