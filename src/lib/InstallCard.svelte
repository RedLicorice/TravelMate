<script lang="ts">
	import { install, promptInstall } from './pwa.svelte';

	let dismissed = $state(false);
	let showIosHelp = $state(false);

	const KEY = 'tm:install-dismissed';
	$effect(() => {
		try {
			dismissed = localStorage.getItem(KEY) === '1';
		} catch {
			// Private mode can throw on access. Showing the card is the safe
			// failure: worst case the traveller dismisses it twice.
		}
	});

	function hide() {
		dismissed = true;
		try {
			localStorage.setItem(KEY, '1');
		} catch {
			/* nothing to do; it reappears next launch */
		}
	}
</script>

{#if !install.installed && !dismissed && (install.available || install.manual)}
	<div class="tm-card mb-4" style="background: var(--tm-peach-soft); border-color: transparent">
		<div class="flex items-start justify-between gap-3">
			<div>
				<p class="tm-card__title" style="color: var(--tm-peach-ink)">Add to home screen</p>
				<p class="tm-card__meta" style="color: var(--tm-peach-ink)">
					Opens full screen and keeps your plan available without signal.
				</p>
			</div>
			<button
				onclick={hide}
				aria-label="Dismiss"
				class="tm-btn tm-btn--ghost"
				style="min-height: auto; padding: 0 4px; color: var(--tm-peach-ink)">×</button
			>
		</div>

		{#if install.available}
			<button class="tm-btn tm-btn--primary tm-btn--block mt-3" onclick={() => promptInstall()}>
				Install
			</button>
		{:else}
			<button
				class="tm-btn tm-btn--secondary tm-btn--block mt-3"
				onclick={() => (showIosHelp = !showIosHelp)}
			>
				{showIosHelp ? 'Got it' : 'How?'}
			</button>
			{#if showIosHelp}
				<!-- iOS exposes no install API, so the only honest thing is to say
				     where the button is rather than offer one that does nothing. -->
				<ol
					class="mt-3 flex flex-col gap-1"
					style="color: var(--tm-peach-ink); font: 400 var(--tm-text-sm)/1.5 var(--tm-font); padding-left: 1.1rem; list-style: decimal"
				>
					<li>Tap the Share button in Safari's toolbar.</li>
					<li>Scroll down and choose <strong>Add to Home Screen</strong>.</li>
					<li>Tap <strong>Add</strong>.</li>
				</ol>
			{/if}
		{/if}
	</div>
{/if}
