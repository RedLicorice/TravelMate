<script lang="ts">
	import { formatter } from '$lib/clock';
	import type { PlannedDay } from '$lib/plan/planner';
	import type { Day } from '$lib/trip/days';

	type Props = {
		/** The day this rail stands for. Absent means there is no such day. */
		day?: PlannedDay | null;
		window?: Day | null;
		timezone: string;
		dayColor: string;
		/**
		 * 'here' is the day on screen: the cards sit on top of it, so the rail
		 * shows through only where nothing is planned. A neighbour is a preview
		 * -- its own cards drawn small, since they are not on screen to sit on
		 * it. A stub stands where there is no day at all: the far side of the
		 * first morning or the last evening, drawn so the row of rails keeps
		 * its shape rather than jumping about at the ends of the trip.
		 */
		kind: 'here' | 'neighbour' | 'stub';
		label?: string | null;
		lit?: boolean;
		/** When the held card would land, while one is being placed. A moment
		    rather than a position, so the rail does the timezone arithmetic
		    once, here, where the day's midnight is already known. */
		marker?: Date | null;
		/**
		 * Where a moment is on this rail, as a percentage from the top -- given
		 * for the day on screen, whose rail is read off its own cards so that
		 * a card's start and end are where the rail says. Absent, the rail is
		 * to scale from the start of its day to the end.
		 */
		place?: ((ms: number) => number) | null;
	};

	let {
		day = null,
		window: win = null,
		timezone,
		dayColor,
		kind,
		label = null,
		lit = false,
		marker = null,
		place = null
	}: Props = $props();

	const midnight = $derived.by(() => {
		if (!win) return 0;
		const [h, m] = formatter('en-GB', {
			timeZone: timezone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		})
			.format(win.start)
			.split(':')
			.map(Number);
		return win.start.getTime() - ((h % 24) * 60 + m) * 60_000;
	});

	const at = (d: Date) => Math.round((d.getTime() - midnight) / 60_000);

	const span = $derived.by(() => {
		if (!win) return { from: 0, to: 1440 };
		const marks = (day?.stops ?? []).flatMap((s) => [at(s.arrive), at(s.depart)]);
		const from = Math.floor(Math.min(at(win.start), ...marks) / 60) * 60;
		const to = Math.ceil(Math.max(at(win.end), ...marks) / 60) * 60;
		return { from, to: Math.max(to, from + 120) };
	});

	const pc = (minutes: number) =>
		place ? place(midnight + minutes * 60_000) : ((minutes - span.from) / (span.to - span.from)) * 100;

	/** Hours the day is not the traveller's: before landing, after leaving. */
	const dead = $derived(
		win
			? [
					{ top: 0, height: Math.max(0, pc(at(win.start))) },
					{ top: pc(at(win.end)), height: Math.max(0, 100 - pc(at(win.end))) }
				].filter((z) => z.height > 0.5)
			: []
	);

	/** A neighbour's own cards, drawn on its rail so you can see what you are
	    dropping between. Never for the day on screen: its cards are already
	    there, sitting on the rail itself. */
	const segments = $derived(
		kind === 'neighbour'
			? (day?.stops ?? []).map((s, i) => ({
					key: `${s.name}:${i}`,
					top: pc(at(s.arrive)),
					height: Math.max(1, pc(at(s.depart)) - pc(at(s.arrive)))
				}))
			: []
	);

	const hhmm = (m: number) =>
		`${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
</script>

<!-- Its scale, for whoever reads a moment off it: the drag does. -->
<div
	class="tm-rail"
	data-rail-from={win ? midnight + span.from * 60_000 : undefined}
	data-rail-to={win ? midnight + span.to * 60_000 : undefined}
	class:tm-rail--near={kind === 'neighbour'}
	class:tm-rail--stub={kind === 'stub'}
	class:tm-rail--lit={lit}
>
	{#if label}<span class="tm-rail__label">{label}</span>{/if}

	{#if win}
		{#each dead as zone}
			<div class="tm-rail__dead" style="top:{zone.top}%;height:{zone.height}%"></div>
		{/each}

		{#each segments as seg (seg.key)}
			<div
				class="tm-rail__seg"
				style="top:{seg.top}%;height:{seg.height}%;background:{dayColor}"
			></div>
		{/each}

		{#if marker}
			<div class="tm-rail__mark" style="top:{pc(at(marker))}%">
				<span>{hhmm(at(marker) % 1440)}</span>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* One vertical line standing for a day, drawn behind the cards. Where a
	   card covers it there is something planned; where it shows through there
	   is not. */
	.tm-rail {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 10px;
		border-radius: 999px;
		background: var(--tm-surface-2);
		border: 1px solid var(--tm-border);
		pointer-events: none;
	}

	.tm-rail--near {
		width: 6px;
		opacity: 0.4;
	}

	/* Nothing on the other side of it: the trip starts here, or ends here. */
	.tm-rail--stub {
		width: 6px;
		opacity: 0.18;
		background: transparent;
		border-style: dashed;
	}

	.tm-rail--lit {
		opacity: 1;
		border-color: var(--tm-primary);
		box-shadow: 0 0 0 2px var(--tm-primary);
	}

	.tm-rail__label {
		position: absolute;
		top: -15px;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		font: 600 10px/1 var(--tm-font);
		color: var(--tm-text-faint);
	}

	/* Hours that are not the traveller's. Underneath everything, and see-
	   through: scenery, never in the way of a card or a time. */
	.tm-rail__dead {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 0;
		opacity: 0.5;
		background: repeating-linear-gradient(135deg, var(--tm-border) 0 2px, transparent 2px 5px);
	}

	.tm-rail__seg {
		position: absolute;
		left: 1px;
		right: 1px;
		border-radius: 2px;
		min-height: 2px;
	}

	/* Where the card would land, and when. */
	.tm-rail__mark {
		position: absolute;
		left: -6px;
		right: -6px;
		height: 0;
		border-top: 2px solid var(--tm-primary);
		z-index: 70;
	}

	.tm-rail__mark span {
		position: absolute;
		left: 50%;
		top: -0.9em;
		transform: translateX(-50%);
		padding: 3px 10px;
		border-radius: 999px;
		background: var(--tm-primary);
		color: var(--tm-primary-ink);
		font: 700 15px/1.3 var(--tm-font-num);
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
	}
</style>
