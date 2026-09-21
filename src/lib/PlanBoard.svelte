<script lang="ts">
	import type { Day } from '$lib/trip/days';
	import type { PlannedDay, PlannedStop } from '$lib/plan/planner';
	import type { createDrag } from '$lib/dnd.svelte';
	import { stack } from '$lib/board';

	type Props = {
		days: Day[];
		planned: PlannedDay[];
		timezone: string;
		dayColor: (index: number) => string;
		drag: ReturnType<typeof createDrag>;
		pinned?: Set<string>;
		onpick?: (poiId: string) => void;
		onpin?: (poiId: string) => void;
		/** Tapped empty time. `beforeId` is the stop the new one should precede. */
		onadd?: (dayIndex: number, beforeId: string | null) => void;
	};

	let {
		days,
		planned,
		timezone,
		dayColor,
		drag,
		pinned = new Set<string>(),
		onpick,
		onpin,
		onadd
	}: Props = $props();

	/**
	 * Hotel or terminal. Stored plans written before the plan carried the kind
	 * have none, so fall back to the day's own waypoints, which always do --
	 * otherwise every anchor on an existing trip reads as the hotel until the
	 * traveller regenerates.
	 */
	function anchorKind(stop: PlannedStop, dayIndex: number): 'hotel' | 'terminal' | 'service' {
		if (stop.anchorKind) return stop.anchorKind;
		const window = days[dayIndex];
		const match = [...(window?.fixedStart ?? []), ...(window?.fixedEnd ?? [])].find(
			(w) => w.name === stop.name
		);
		return match?.kind ?? 'hotel';
	}

	type Card = {
		key: string;
		top: number;
		height: number;
		accent: string;
		fill: string;
		ink: string;
		title: string;
		sub: string | null;
		icon: string | null;
		stop: PlannedStop | null;
	};

	/**
	 * A day as cards, in time order and pushed apart so none overlaps.
	 *
	 * Built up front rather than positioned inline, because "does this block
	 * run into the next one" is a question about the whole day and cannot be
	 * answered one block at a time.
	 */
	function cardsFor(day: PlannedDay, dayIndex: number): Card[] {
		const out: Card[] = [];

		day.stops.forEach((stop, j) => {
			const startMin = minutesOf(stop.arrive);

			// Travel is a card like any other. It takes time, and a board that
			// drew it as a gap said the day was emptier than it is.
			// A leg of no length is two cards standing in the same place, which
			// is the whole journey chain. Drawing it would put a travel card
			// between every airport and its flight.
			if (stop.legIn && stop.legIn.minutes > 0 && j > 0) {
				const leaveMin = minutesOf(day.stops[j - 1].depart);
				out.push({
					key: `leg:${j}`,
					top: top(leaveMin),
					height: Math.max(MIN_BLOCK_PX, (startMin - leaveMin) * PX_PER_MIN),
					accent: 'var(--tm-border-strong)',
					fill: 'var(--tm-surface-2)',
					ink: 'var(--tm-text-muted)',
					title: MODE_LABEL[stop.legIn.mode] ?? 'Travel',
					sub: `${stop.legIn.minutes} min`,
					icon: MODE_ICON[stop.legIn.mode] ?? MODE_ICON.walk,
					stop: null
				});
			}

			const height = Math.max(MIN_BLOCK_PX, stop.durationMin * PX_PER_MIN);
			if (stop.anchor) {
				const kind = anchorKind(stop, dayIndex);
				const tone = kind === 'terminal' ? 'peach' : kind === 'service' ? 'mint' : 'sky';
				out.push({
					key: `stop:${j}`,
					top: top(startMin),
					height,
					accent: `var(--tm-${tone})`,
					fill: `var(--tm-${tone}-soft)`,
					ink: `var(--tm-${tone}-ink)`,
					title: stop.name,
					// A journey card's real time is on the ticket, not on the
					// trip's clock -- they all cost nothing, so the clock gives
					// every one of them the same minute.
					sub: stop.timeLabel ?? (stop.durationMin ? `${stop.durationMin} min` : null),
					icon: null,
					stop: null
				});
			} else {
				out.push({
					key: `stop:${j}`,
					top: top(startMin),
					height,
					accent: stop.poiId && pinned.has(stop.poiId) ? 'var(--tm-butter)' : dayColor(dayIndex),
					fill: 'var(--tm-surface)',
					ink: 'var(--tm-text-faint)',
					title: stop.name,
					sub: `${stop.durationMin} min${stop.exitAt ? ' · ends elsewhere' : ''}`,
					icon: null,
					stop
				});
			}
		});

		return stack(out);
	}

	/**
	 * Which stop a tap at this height should land above. The first real stop
	 * that has not started yet; null when the tap is after all of them, which
	 * means the end of the day.
	 */
	function slotAtHeight(day: PlannedDay, offsetY: number): string | null {
		const minutes = range.from + offsetY / PX_PER_MIN;
		const next = day.stops.find((s) => s.poiId && minutesOf(s.arrive) >= minutes);
		return next?.poiId ?? null;
	}

	/** Minutes past local midnight. The grid's only unit. */
	function minutesOf(at: Date): number {
		const [h, m] = new Intl.DateTimeFormat('en-GB', {
			timeZone: timezone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		})
			.format(at)
			.split(':')
			.map(Number);
		return (h % 24) * 60 + m;
	}

	/** Small glyphs for the travel blocks, matching the day view's legs. */
	const MODE_ICON: Record<string, string> = {
		walk: 'M11 21l2-6-3-3 1-5 3 3 3 1M10 12l-2 9',
		bike: 'M6 17l5-8h5M14 9l4 8',
		transit: 'M5 11h14M8 20l2-4M16 20l-2-4',
		car: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9',
		carshare: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9'
	};

	const MODE_LABEL: Record<string, string> = {
		walk: 'Walk',
		bike: 'Cycle',
		transit: 'Transit',
		car: 'Drive',
		carshare: 'Drive'
	};

	const PX_PER_MIN = 1.1; // 66px an hour: an hour is a comfortable thumb target
	const MIN_BLOCK_PX = 26;

	/** One hour of air either side, so blocks are not flush against the edge. */
	const range = $derived.by(() => {
		if (!days.length) return { from: 8 * 60, to: 20 * 60 };
		const starts = days.map((d) => minutesOf(d.start));
		const ends = days.map((d) => minutesOf(d.end));
		const from = Math.max(0, Math.floor(Math.min(...starts) / 60) * 60 - 60);
		const to = Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60 + 60);
		return { from, to: Math.max(to, from + 180) };
	});

	const clockHeight = $derived((range.to - range.from) * PX_PER_MIN);

	/**
	 * Tall enough for the clock, and for any day whose cards were pushed past
	 * the end of it by stacking. Every column is the same height so the hour
	 * lines stay level across the board.
	 */
	const height = $derived(
		planned.reduce((tallest, day, i) => {
			const last = cardsFor(day, i).at(-1);
			return last ? Math.max(tallest, last.top + last.height + 8) : tallest;
		}, clockHeight)
	);
	const top = (minutes: number) => (minutes - range.from) * PX_PER_MIN;

	const hours = $derived(
		Array.from({ length: Math.ceil((range.to - range.from) / 60) + 1 }, (_, i) => range.from + i * 60)
	);

	const label = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:00`;

	const dayLabel = (iso: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'short', day: 'numeric' })
			.format(new Date(`${iso}T12:00:00Z`));

</script>


<!--
  One card shape for everything on the board. A stop, the hotel, a terminal and
  a leg of travel are all the same object to a traveller reading a day: a block
  of time with a name on it. They differ by colour, not by shape.
-->
{#snippet card(o: Card)}
	{@const held = o.stop?.poiId ? pinned.has(o.stop.poiId) : false}
	<div
		class="tm-board-card"
		data-drop-stop={o.stop?.poiId ?? undefined}
		title={o.sub ? `${o.title} · ${o.sub}` : o.title}
		style="top:{o.top}px;height:{o.height}px;background:{o.fill};
		border-left-color:{o.accent};
		{o.stop && drag.state.id === o.stop.poiId ? 'opacity:0.35;' : ''}
		{o.stop && drag.state.target?.kind === 'stop' && drag.state.target.id === o.stop.poiId
			? 'outline:2px solid var(--tm-primary);outline-offset:-1px;'
			: ''}"
	>
		<div style="display:flex;align-items:flex-start;gap:4px">
			{#if o.stop?.poiId}
				<span
					{@attach (node) => drag.handle(node as HTMLElement, o.stop!.poiId!)}
					aria-hidden="true"
					style="cursor:grab;touch-action:none;color:var(--tm-text-faint);
					font-size:11px;line-height:1.2;user-select:none;flex:none"
				>⠿</span>
			{:else if o.icon}
				<svg
					width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					stroke-width="2.4" stroke-linecap="round" aria-hidden="true"
					style="flex:none;margin-top:1px;color:{o.ink}"
				>
					<path d={o.icon} />
				</svg>
			{/if}

			{#if o.stop?.poiId}
				<button class="tm-board-title" onclick={() => onpick?.(o.stop!.poiId!)}>{o.title}</button>
			{:else}
				<span class="tm-board-title" style="color:{o.ink}">{o.title}</span>
			{/if}

			{#if onpin && o.stop?.poiId}
				<button
					class="tm-board-pin"
					class:tm-board-pin--on={held}
					aria-pressed={held}
					aria-label={held ? `Unpin ${o.title}` : `Pin ${o.title}`}
					title={held ? 'Replan may not move this' : 'Hold this where it is'}
					onclick={() => onpin?.(o.stop!.poiId!)}
				>
					<svg width="10" height="10" viewBox="0 0 24 24" fill={held ? 'currentColor' : 'none'}
						stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
						<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
					</svg>
				</button>
			{/if}
		</div>

		{#if o.sub && o.height > 38}
			<p class="tm-board-sub" style="color:{o.ink}">{o.sub}</p>
		{/if}
		{#if o.stop?.warnings.length && o.height > 54}
			<p class="tm-board-sub" style="color:var(--tm-warn-ink);font-weight:600">
				{o.stop.warnings[0].message}
			</p>
		{/if}
	</div>
{/snippet}

<div class="flex h-full flex-col">
	<div class="flex-1 overflow-auto" style="-webkit-overflow-scrolling: touch">
		<div class="flex" style="width: max-content; min-width: 100%">
			<!-- Hour gutter -->
			<div style="width: 46px; flex: none; position: sticky; left: 0; z-index: 2; background: var(--tm-bg)">
				<div style="height: 30px"></div>
				<div style="position: relative; height: {height}px">
					{#each hours as h}
						<span
							style="position:absolute;top:{top(h) - 6}px;right:6px;
							font:500 var(--tm-text-xs)/1 var(--tm-font);color:var(--tm-text-faint)"
						>
							{label(h)}
						</span>
					{/each}
				</div>
			</div>

			{#each planned as day, i (day.date)}
				{@const window = days[i]}
				<!-- Share whatever width is going, down to a floor. Fixed columns
				     left half a desktop empty; a floor keeps a card readable, and
				     a week of days simply scrolls. -->
				<div
					data-drop-day={i}
					style="flex: 1 1 0; min-width: 116px; border-left: 1px solid var(--tm-border)"
				>
					<div
						style="height:30px;position:sticky;top:0;z-index:1;background:var(--tm-bg);
						border-bottom:1px solid var(--tm-border);display:flex;align-items:center;
						justify-content:center;gap:6px;
						{drag.state.target?.kind === 'day' && drag.state.target.index === i
							? 'outline:2px dashed var(--tm-primary);outline-offset:-2px'
							: ''}"
					>
						<span style="width:9px;height:9px;border-radius:50%;background:{dayColor(i)}"></span>
						<span style="font:600 var(--tm-text-sm)/1 var(--tm-font)">{dayLabel(day.date)}</span>
					</div>

					<div style="position: relative; height: {height}px">
						<!-- Outside the day's own window: not planning time at all. -->
						<div
							style="position:absolute;left:0;right:0;top:0;height:{Math.max(0, top(minutesOf(window.start)))}px;
							background:var(--tm-surface-2);opacity:0.55"
						></div>
						<div
							style="position:absolute;left:0;right:0;top:{top(minutesOf(window.end))}px;bottom:0;
							background:var(--tm-surface-2);opacity:0.55"
						></div>

						{#each hours as h}
							<div
								style="position:absolute;left:0;right:0;top:{top(h)}px;height:1px;
								background:var(--tm-border);opacity:0.7"
							></div>
						{/each}

						<!-- Empty time is a place to put something. Drawn before the
						     blocks so it only catches taps that miss them. -->
						{#if onadd}
							<button
								class="tm-board-empty"
								aria-label="Add a stop to {dayLabel(day.date)}"
								onclick={(e) => onadd?.(i, slotAtHeight(day, e.offsetY))}
							></button>
						{/if}

						{#each cardsFor(day, i) as block (block.key)}
							{@render card(block)}
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>

	<p class="tm-hint px-4 py-2" style="border-top: 1px solid var(--tm-border)">
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-surface-2);
			border-left:3px solid var(--tm-border-strong);vertical-align:-1px"
		></span>
		travelling ·
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-sky-soft);border-left:3px solid var(--tm-sky);vertical-align:-1px"
		></span>
		hotel ·
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-peach-soft);border-left:3px solid var(--tm-peach);vertical-align:-1px"
		></span>
		terminal ·
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-mint-soft);border-left:3px solid var(--tm-mint);vertical-align:-1px"
		></span>
		flight or train · hold ⠿ to move a stop between days · tap empty time to add
	</p>
</div>

<style>
	/* Covers the whole column so any gap between blocks is tappable. It sits
	   under them in paint order, so it never steals a tap meant for a stop. */
	.tm-board-empty {
		position: absolute;
		inset: 0;
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		cursor: copy;
	}

	/* Every block on the board: a stop, the hotel, a terminal, a leg of travel.
	   Only the accent and the fill change. */
	.tm-board-card {
		position: absolute;
		left: 4px;
		right: 4px;
		border-radius: 8px;
		overflow: hidden;
		padding: 4px 6px;
		border: 1px solid var(--tm-border);
		border-left: 3px solid var(--tm-border-strong);
	}

	.tm-board-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-align: left;
		font: 600 11px/1.2 var(--tm-font);
		color: inherit;
		background: none;
		border: none;
		padding: 0;
	}

	button.tm-board-title {
		cursor: pointer;
	}

	.tm-board-sub {
		font: 400 9.5px/1.2 var(--tm-font);
		margin-top: 2px;
	}

	.tm-board-pin {
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: none;
		cursor: pointer;
		color: var(--tm-text-faint);
		opacity: 0.5;
	}

	.tm-board-pin:hover,
	.tm-board-pin:focus-visible {
		opacity: 1;
	}

	.tm-board-pin--on {
		opacity: 1;
		color: var(--tm-butter-ink);
		background: var(--tm-butter-soft);
	}
</style>
