<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { ensureSession, isConfigured } from '$lib/supabase';
	import { getProfile, myStats, errText } from '$lib/api';
	import { fmtVolume, type Profile } from '$lib/types';

	let profile = $state<Profile | null>(null);
	let stats = $state<{ places: number; given: number; received: number } | null>(null);
	let error = $state<string | null>(null);
	let configured = $state(true);

	const remaining = $derived(profile ? profile.total_volume - profile.used_volume : 0);
	const fillPct = $derived(
		profile && profile.total_volume > 0 ? (remaining / profile.total_volume) * 100 : 0
	);

	onMount(async () => {
		configured = isConfigured();
		if (!configured) return;
		try {
			const userId = await ensureSession();
			profile = await getProfile(userId);
			try {
				stats = await myStats();
			} catch {
				stats = null; // migration 0005 not applied yet
			}
		} catch (e) {
			error = errText(e);
		}
	});
</script>

<main>
	<header>
		<h1>ART</h1>
		<p class="sub">AR tagging · leave your mark where you stand</p>
	</header>

	{#if !configured}
		<div class="card">
			<h2>Not configured</h2>
			<p>
				Copy <code>.env.example</code> to <code>.env</code> and fill in your Supabase project URL
				and anon key, then restart the dev server.
			</p>
		</div>
	{:else if error}
		<div class="card">
			<h2>Connection failed</h2>
			<p>{error}</p>
			<p class="hint">
				Is the migration applied and anonymous sign-in enabled (Auth → Providers → Anonymous)?
			</p>
		</div>
	{:else}
		<div class="card can-card">
			<div class="can" aria-hidden="true">
				<div class="can-fill" style="height: {fillPct}%"></div>
			</div>
			<div class="can-stats">
				<h2>Your spray can</h2>
				{#if profile}
					<p class="big">{fmtVolume(remaining)} <span class="unit">left</span></p>
					<p class="hint">
						{fmtVolume(profile.used_volume)} of {fmtVolume(profile.total_volume)} used ·
						appraisals from others grow your can (+25 cm³ each)
					</p>
				{:else}
					<p class="hint">signing in…</p>
				{/if}
			</div>
		</div>

		{#if stats}
			<div class="card stats">
				<div><strong>{stats.places}</strong><span>Places</span></div>
				<div><strong>{stats.given}</strong><span>Appraisals given</span></div>
				<div><strong>{stats.received}</strong><span>Appraisals received</span></div>
			</div>
		{/if}

		<button class="cta" onclick={() => goto('/spray')} disabled={!profile}>
			SPRAY
		</button>


		<ul class="notes">
			<li>Needs camera and location access — grant both when asked.</li>
			<li>SPRAY finds the nearest tagged wall with GPS — or turns the wall in front of you into one, automatically.</li>
			<li>Hold &amp; drag on a locked wall to spray caulk; tap a tag to appraise it.</li>
		</ul>

		<p class="build">build {__BUILD_TS__}</p>
	{/if}
</main>

<style>
	main {
		max-width: 28rem;
		margin: 0 auto;
		padding: 2rem 1.25rem calc(2rem + env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-height: 100dvh;
		box-sizing: border-box;
	}
	h1 {
		font-size: 3rem;
		margin: 0;
		letter-spacing: 0.08em;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.sub {
		color: var(--muted);
		margin: 0.25rem 0 0;
	}
	.card {
		background: var(--panel);
		border-radius: 1rem;
		padding: 1.25rem;
	}
	.can-card {
		display: flex;
		gap: 1.25rem;
		align-items: center;
	}
	.can {
		width: 3.25rem;
		height: 6.5rem;
		border: 2px solid var(--muted);
		border-radius: 0.6rem 0.6rem 0.8rem 0.8rem;
		position: relative;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: flex-end;
	}
	.can::before {
		content: '';
		position: absolute;
		top: -0.55rem;
		left: 30%;
		width: 40%;
		height: 0.5rem;
		border: 2px solid var(--muted);
		border-radius: 0.2rem;
	}
	.can-fill {
		width: 100%;
		background: linear-gradient(180deg, var(--accent-2), var(--accent));
		transition: height 0.6s ease;
	}
	h2 {
		margin: 0 0 0.35rem;
		font-size: 1.05rem;
	}
	.big {
		font-size: 1.9rem;
		font-weight: 700;
		margin: 0;
	}
	.unit {
		font-size: 0.9rem;
		font-weight: 400;
		color: var(--muted);
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0.4rem 0 0;
	}
	.cta {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		color: #0b0b0f;
		font-weight: 700;
		font-size: 1.15rem;
		border: none;
		border-radius: 1rem;
		padding: 1rem;
		cursor: pointer;
	}
	.cta:disabled {
		opacity: 0.5;
	}
	.stats {
		display: flex;
		justify-content: space-between;
		text-align: center;
	}
	.stats div {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		flex: 1;
	}
	.stats strong {
		font-size: 1.4rem;
	}
	.stats span {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.notes {
		color: var(--muted);
		font-size: 0.85rem;
		padding-left: 1.1rem;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.build {
		color: var(--muted);
		font-size: 0.7rem;
		opacity: 0.6;
		margin: 0;
	}
	code {
		background: #26262f;
		padding: 0.1rem 0.35rem;
		border-radius: 0.3rem;
	}
</style>
