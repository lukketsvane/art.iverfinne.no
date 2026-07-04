<script lang="ts">
	let { children } = $props();
</script>

{@render children()}

<style>
	:global(:root) {
		color-scheme: dark;
		--bg: #0b0b0f;
		--panel: #16161d;
		--text: #f4f4f5;
		--muted: #9ca3af;
		--accent: #e11dff;
		--accent-2: #22d3ee;
	}
	:global(html, body) {
		margin: 0;
		height: 100%;
		background: var(--bg);
		color: var(--text);
		font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
		-webkit-font-smoothing: antialiased;
		overscroll-behavior: none;
	}
	/* App feel: nothing on screen is selectable or long-press-copyable... */
	:global(*) {
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
		-webkit-tap-highlight-color: transparent;
	}
	/* ...except actual text inputs. */
	:global(input, textarea) {
		-webkit-user-select: text;
		user-select: text;
	}
	:global(button) {
		font: inherit;
	}
</style>
