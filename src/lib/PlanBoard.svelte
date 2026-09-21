<script lang="ts">
	import type { Day } from '$lib/trip/days';
	import type { PlannedDay } from '$lib/plan/planner';
	import { toHours, type MealWindows } from '$lib/plan/meals';
	import type { createDrag } from '$lib/dnd.svelte';

	type Props = {
		days: Day[];
		planned: PlannedDay[];
		timezone: string;
		mealWindows: MealWindows;
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
		mealWindows,
		dayColor,
		drag,
		pinned = new Set<string>(),
		onpick,
		onpin,
		onadd
	}: Props = $props();

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

	const height = $derived((range.to - range.from) * PX_PER_MIN);
	const top = (minutes: number) => (minutes - range.from) * PX_PER_MIN;

	const hours = $derived(
		Array.from({ length: Math.ceil((range.to - range.from) / 60) + 1 }, (_, i) => range.from + i * 60)
	);

	const label = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:00`;

	const dayLabel = (iso: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'short', day: 'numeric' })
			.format(new Date(`${iso}T12:00:00Z`));

	/** Meal bands, shaded so a gap at 13:00 reads as lunch rather than dead air. */
	const bands = $derived(
		(['lunch', 'dinner'] as const).map((name) => ({
			name,
			from: toHours(mealWindows[name].from) * 60,
			to: toHours(mealWindows[name].to) * 60
		}))
	);
</script>

<div class="flex h-full flex-col">
	<div class="flex-1 overflow-auto" style="-webkit-overflow-scrolling: touch">
		<div class="flex" style="min-width: max-content">
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
				<div
					data-drop-day={i}
					style="width: 138px; flex: none; border-left: 1px solid var(--tm-border)"
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

						{#each bands as band}
							<div
								title={band.name}
								style="position:absolute;left:0;right:0;top:{top(band.from)}px;
								height:{(band.to - band.from) * PX_PER_MIN}px;
								background:var(--tm-butter-soft);
								border-top:1px solid var(--tm-butter);border-bottom:1px solid var(--tm-butter)"
							></div>
						{/each}

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

						{#each day.stops as stop, j (stop.name + j)}
							{@const startMin = minutesOf(stop.arrive)}
							{#if stop.legIn && j > 0}
								{@const leaveMin = minutesOf(day.stops[j - 1].depart)}
								{@const travelHeight = Math.max(14, (startMin - leaveMin) * PX_PER_MIN)}
								<!-- Travel occupies the board, it is not a gap between cards.
								     An empty space reads as free time; it is not. -->
								<div
									title="{stop.legIn.minutes} min by {stop.legIn.mode}"
									style="position:absolute;left:10px;right:10px;top:{top(leaveMin)}px;
									height:{travelHeight}px;border-radius:6px;
									background:var(--tm-surface-2);
									border:1px solid var(--tm-border);
									display:flex;align-items:center;justify-content:center;gap:4px;
									overflow:hidden;color:var(--tm-text-faint)"
								>
									<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
										stroke-width="2.4" stroke-linecap="round">
										<path d={MODE_ICON[stop.legIn.mode] ?? MODE_ICON.walk} />
									</svg>
									{#if travelHeight > 24}
										<span style="font:600 9px/1 var(--tm-font)">{stop.legIn.minutes}m</span>
									{/if}
								</div>
							{/if}
							{@const blockHeight = Math.max(MIN_BLOCK_PX, stop.durationMin * PX_PER_MIN)}
							{#if stop.anchor}
								<div
									style="position:absolute;left:4px;right:4px;top:{top(startMin)}px;
									height:{Math.max(18, blockHeight)}px;border-radius:6px;
									background:var(--tm-butter-soft);
									display:flex;align-items:center;padding:0 6px;
									font:500 10px/1.1 var(--tm-font);color:var(--tm-butter-ink);overflow:hidden"
								>
									{stop.name}
								</div>
							{:else}
								<div
									data-drop-stop={stop.poiId}
									style="position:absolute;left:4px;right:4px;top:{top(startMin)}px;
									height:{blockHeight}px;border-radius:8px;overflow:hidden;
									background:var(--tm-surface);
									border-left:3px solid {stop.poiId && pinned.has(stop.poiId) ? 'var(--tm-butter)' : dayColor(i)};
									border-top:1px solid var(--tm-border);border-right:1px solid var(--tm-border);
									border-bottom:1px solid var(--tm-border);padding:4px 6px;
									{drag.state.id === stop.poiId ? 'opacity:0.35;' : ''}
									{drag.state.target?.kind === 'stop' && drag.state.target.id === stop.poiId
										? 'outline:2px solid var(--tm-primary);outline-offset:-1px;'
										: ''}"
								>
									<div style="display:flex;align-items:flex-start;gap:4px">
										<span
											{@attach (node) => drag.handle(node as HTMLElement, stop.poiId!)}
											aria-hidden="true"
											style="cursor:grab;touch-action:none;color:var(--tm-text-faint);
											font-size:11px;line-height:1.2;user-select:none;flex:none"
										>⠿</span>
										<button
											onclick={() => stop.poiId && onpick?.(stop.poiId)}
											style="background:none;border:none;padding:0;text-align:left;cursor:pointer;
											color:inherit;font:600 11px/1.2 var(--tm-font);overflow:hidden;flex:1"
										>
											{stop.name}
										</button>
										{#if onpin && stop.poiId}
											{@const held = pinned.has(stop.poiId)}
											<button
												class="tm-board-pin"
												class:tm-board-pin--on={held}
												aria-pressed={held}
												aria-label={held ? 'Unpin {stop.name}' : 'Pin {stop.name}'}
												title={held ? 'Replan may not move this' : 'Hold this where it is'}
												onclick={() => onpin?.(stop.poiId!)}
											>
												<svg width="10" height="10" viewBox="0 0 24 24" fill={held ? 'currentColor' : 'none'}
													stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
													<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
												</svg>
											</button>
										{/if}
									</div>
									{#if blockHeight > 38}
										<p style="font:400 9.5px/1.2 var(--tm-font);color:var(--tm-text-faint);margin-top:2px">
											{stop.durationMin} min{stop.exitAt ? ' · ends elsewhere' : ''}
										</p>
									{/if}
									{#if stop.warnings.length && blockHeight > 54}
										<p style="font:600 9px/1.2 var(--tm-font);color:var(--tm-warn-ink);margin-top:3px">
											{stop.warnings[0].message}
										</p>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>

	<p class="tm-hint px-4 py-2" style="border-top: 1px solid var(--tm-border)">
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-butter-soft);border:1px solid var(--tm-butter);vertical-align:-1px"
		></span>
		mealtimes ·
		<span
			style="display:inline-block;width:10px;height:10px;border-radius:2px;
			background:var(--tm-surface-2);
			border:1px solid var(--tm-border);vertical-align:-1px"
		></span>
		travelling · hold ⠿ to move a stop between days · tap empty time to add
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
