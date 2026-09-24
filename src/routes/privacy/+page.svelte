<script lang="ts">
	import { base } from '$app/paths';
	import { DATA_REGION, DIAGNOSTICS_DAYS, NOTICES_DATED, OPERATOR } from '$lib/legal';
</script>

<svelte:head><title>Privacy notice · TravelMate</title></svelte:head>

<main class="tm-legal mx-auto max-w-prose p-6">
	<a href="{base}/" class="tm-attrib">← TravelMate</a>
	<h1>Privacy notice</h1>
	<p class="tm-hint">Last updated {NOTICES_DATED}</p>

	<h2>Who is responsible</h2>
	<p>
		The data controller is {OPERATOR.name}, {OPERATOR.address} (VAT {OPERATOR.vatId}). For anything about
		your data, write to <a href="mailto:{OPERATOR.email}">{OPERATOR.email}</a>.
	</p>

	<h2>What we keep, and why</h2>
	<ul>
		<li>
			<strong>Your account</strong> — your email address and a password (stored only as a hash), or the
			sign-in you chose with another provider; your name, picture and preferences if you set them. Needed
			to give you an account (the contract, GDPR art. 6(1)(b)).
		</li>
		<li>
			<strong>Your trips</strong> — cities, dates, hotels, journeys, the places on your wishlist and your
			plan, and who you share each trip with. Needed to provide the service (art. 6(1)(b)). The people you
			share a trip with see it, and see your name and picture.
		</li>
		<li>
			<strong>On your device</strong> — your sign-in and a copy of your trips, so the app works without a
			connection. This is needed for the app to work and is not used to track you. There are no
			advertising or tracking cookies.
		</li>
		<li>
			<strong>Diagnostics, only if you allow them</strong> — what the app did and what went wrong: the
			name of each action, when, the trip it was on, what you searched for, and error and console
			messages. Used only to find and fix faults. Based on your consent (art. 6(1)(a)), which you can
			withdraw at any time in your profile; withdrawing deletes what was sent.
		</li>
	</ul>

	<h2>Where it is kept, and who else handles it</h2>
	<ul>
		<li>
			<strong>Supabase</strong> hosts the database and sign-in, in {DATA_REGION}, as our processor.
		</li>
		<li>
			<strong>Google Maps Platform</strong> answers place searches, draws map pictures, and works out
			how long journeys take. It receives what you search for and the coordinates involved, and may process them outside
			the EU under the safeguards Google offers (EU standard contractual clauses and the EU–US Data Privacy
			Framework).
		</li>
		<li>
			<strong>GitHub Pages</strong> serves the app itself; like any web host it sees your IP address when
			you load it.
		</li>
	</ul>
	<p>We do not sell your data or use it for advertising.</p>

	<h2>How long</h2>
	<ul>
		<li>Your account and trips: until you delete them or ask us to.</li>
		<li>Diagnostics: {DIAGNOSTICS_DAYS} days, then deleted automatically.</li>
		<li>Copies on your device: until you sign out, which clears them.</li>
	</ul>

	<h2>Your rights</h2>
	<p>
		You can ask to see, correct, delete or receive a copy of your data, to restrict or object to its use,
		and withdraw consent at any time (GDPR arts. 15–21). A trip can be saved as a file from its details.
		Write to <a href="mailto:{OPERATOR.email}">{OPERATOR.email}</a>; we answer within one month. You may
		also complain to the Garante per la protezione dei dati personali
		(<a href="https://www.garanteprivacy.it" rel="noopener noreferrer" target="_blank">garanteprivacy.it</a>).
	</p>

	<h2>Age</h2>
	<p>TravelMate is not meant for anyone under 14.</p>

	<h2>Changes</h2>
	<p>
		If what we collect changes, this notice changes with it, and the app asks you again before sending
		diagnostics.
	</p>
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
	.tm-legal p,
	.tm-legal li {
		font: 400 var(--tm-text-sm)/1.55 var(--tm-font);
		color: var(--tm-text-muted);
	}
	.tm-legal ul {
		display: flex;
		flex-direction: column;
		gap: var(--tm-space-2);
		padding-left: 1.1em;
		list-style: disc;
	}
	.tm-legal a {
		color: var(--tm-text);
		text-decoration: underline;
	}
</style>
