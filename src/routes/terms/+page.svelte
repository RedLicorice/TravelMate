<script lang="ts">
	import { base } from '$app/paths';
	import { NOTICES_DATED, OPERATOR } from '$lib/legal';
</script>

<svelte:head><title>Terms of service · TravelMate</title></svelte:head>

<main class="tm-legal mx-auto max-w-prose p-6">
	<a href="{base}/" class="tm-attrib">← TravelMate</a>
	<h1>Terms of service</h1>
	<p class="tm-hint">Last updated {NOTICES_DATED}</p>

	<h2>1. The service</h2>
	<p>
		TravelMate is provided by {OPERATOR.name}, {OPERATOR.address} (VAT {OPERATOR.vatId}),
		<a href="mailto:{OPERATOR.email}">{OPERATOR.email}</a>. It helps you plan a trip: it keeps your
		places and journeys and proposes a day-by-day plan. It is free to use.
	</p>

	<h2>2. Your account</h2>
	<p>
		You need an account to plan trips. Keep your sign-in to yourself; you are responsible for what is done
		with it. You must be at least 14 to use TravelMate.
	</p>

	<h2>3. Plans are suggestions</h2>
	<p>
		Travel times, routes, opening hours, crowd levels and place details come from estimates and from
		third parties such as Google and OpenStreetMap. They can be wrong or out of date. Check anything that
		matters — a train, a booking, an opening time — with its source before relying on it. You decide how
		to travel.
	</p>

	<h2>4. Your content and sharing</h2>
	<p>
		What you put in your trips stays yours. You give us the permission needed to store it and show it to
		you and to the people you share a trip with. Share only with people you trust: they can see the trip,
		and editors can change it. Do not use TravelMate for anything unlawful, to harm others, or to disrupt
		the service or the services it relies on.
	</p>

	<h2>5. Availability</h2>
	<p>
		We try to keep TravelMate working and your data safe, but the service is provided as it is, and may
		change, pause or stop. Keep your own copy of anything important: a trip can be saved as a file from
		its details.
	</p>

	<h2>6. Liability</h2>
	<p>
		To the extent Italian law allows, we are not liable for losses caused by relying on a plan or on
		third-party information, or by the service being unavailable. Nothing here limits liability for wilful
		misconduct or gross negligence (art. 1229 of the Italian Civil Code), or any right you have as a
		consumer under the Codice del Consumo.
	</p>

	<h2>7. Ending</h2>
	<p>
		You can stop using TravelMate and ask us to delete your account at any time. We may suspend an account
		that breaks these terms, telling you why unless the law prevents it.
	</p>

	<h2>8. Changes</h2>
	<p>
		If these terms change in a way that matters, we will tell you in the app before the change applies.
	</p>

	<h2>9. Law</h2>
	<p>
		These terms are governed by {OPERATOR.law}. Disputes go to {OPERATOR.courts}. If you are a consumer, you
		may also bring a claim before the court of the place where you live.
	</p>

	<p class="mt-6">How your data is used: <a href="{base}/privacy">Privacy notice</a>.</p>
</main>

<style>
	.tm-legal h1 {
		font: 700 var(--tm-text-2xl)/1.2 var(--tm-font);
		margin: var(--tm-space-3) 0 var(--tm-space-1);
	}
	.tm-legal h2 {
		font: 700 var(--tm-text-base)/1.3 var(--tm-font);
		margin: var(--tm-space-5) 0 var(--tm-space-2);
	}
	.tm-legal p {
		font: 400 var(--tm-text-sm)/1.55 var(--tm-font);
		color: var(--tm-text-muted);
	}
	.tm-legal a {
		color: var(--tm-text);
		text-decoration: underline;
	}
</style>
