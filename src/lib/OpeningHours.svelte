<script lang="ts">
	import { hoursOn, weekdayOf, type OpeningPeriod } from '$lib/plan/hours';

	/**
	 * When a place is open. One line for the day that matters -- the trip day
	 * the place is on, or today for a place on no day -- and, tapped, the
	 * whole week. From the hours kept as data; a place that only has them as
	 * text shows the text; one with neither shows nothing.
	 */
	type Props = {
		periods: OpeningPeriod[] | null;
		text: string | null;
		/** YYYY-MM-DD: the day the line is about. */
		date: string;
		/** How the day is named, e.g. "sab 14"; "today" when it is today. */
		dayName: string;
	};
	let { periods, text, date, dayName }: Props = $props();

	let open = $state(false);
	const WEEK = [1, 2, 3, 4, 5, 6, 0];
	const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const line = $derived(periods?.length ? hoursOn(periods, weekdayOf(date)) : null);
</script>

{#if periods?.length && line}
	<button
		type="button"
		class="tm-card__meta"
		style="display:block;background:none;border:none;padding:0;cursor:pointer;text-align:left"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{line === 'Closed' ? `Closed ${dayName}` : line === 'Open 24 hours' ? 'Open 24 hours' : `Open ${dayName} ${line}`}
		<span aria-hidden="true" style="color:var(--tm-text-faint)">{open ? '▴' : '▾'}</span>
	</button>
	{#if open}
		<dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:4px 0 0">
			{#each WEEK as d}
				<dt class="tm-hint" style="font-weight:{d === weekdayOf(date) ? 700 : 400}">{NAMES[d]}</dt>
				<dd class="tm-hint" style="margin:0;font-variant-numeric:tabular-nums;font-weight:{d === weekdayOf(date) ? 700 : 400}">
					{hoursOn(periods, d)}
				</dd>
			{/each}
		</dl>
	{/if}
{:else if text}
	<p class="tm-card__meta">{text}</p>
{/if}
