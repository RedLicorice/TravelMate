<script lang="ts">
	import { base } from '$app/paths';
	import { choose } from '$lib/consent.svelte';
	import { DIAGNOSTICS_DAYS } from '$lib/legal';

	/**
	 * Asked once, before signing in: may the app send diagnostics?
	 *
	 * What the app needs to work -- the sign-in and the trips kept on this
	 * device -- is said, not asked: it is not optional. Diagnostics are, so
	 * both answers are the same size and neither is chosen in advance.
	 */
</script>

<section
	class="tm-card"
	style="position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:70;max-width:28rem;margin:0 auto;box-shadow:0 6px 24px rgba(0,0,0,0.25)"
	aria-label="Your data"
>
	<p class="tm-card__title">Your data</p>
	<p class="tm-card__meta mt-1" style="line-height:1.45">
		TravelMate keeps your sign-in and your trips on this device and on our server, which it needs to
		work. No tracking cookies and no advertising.
	</p>
	<p class="tm-card__meta mt-2" style="line-height:1.45">
		May it also send diagnostics — what went wrong, and what you did just before — so faults can be
		fixed? They are kept {DIAGNOSTICS_DAYS} days, and you can change your mind in your profile.
	</p>
	<div class="mt-3 flex gap-2">
		<button class="tm-btn tm-btn--secondary flex-1" onclick={() => choose(false)}>No thanks</button>
		<button class="tm-btn tm-btn--secondary flex-1" onclick={() => choose(true)}>Allow diagnostics</button>
	</div>
	<p class="tm-attrib mt-3" style="text-align:center">
		<a href="{base}/privacy">Privacy notice</a> · <a href="{base}/terms">Terms of service</a>
	</p>
</section>
