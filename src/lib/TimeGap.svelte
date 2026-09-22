<script lang="ts">
	/**
	 * The time between two stops, as a space you can open.
	 *
	 * A day used to carry an "Add a stop here" button under every card, which
	 * said nothing about how much time was there and got in the way of dropping
	 * a card that was being dragged. This is the same slot, drawn as what it
	 * actually is: the gap in the day. Tap it and it comes apart, as tall as the
	 * time it holds; tap the open line and the new stop starts at the moment you
	 * touched.
	 */

	type Props = {
		/** When the gap begins: the stop above has been left, travel included. */
		start: Date;
		/** When the gap ends: the stop below is reached. */
		end: Date;
		timezone: string;
		open: boolean;
		/** Whether anything may be added here at all. A viewer may not. */
		fillable?: boolean;
		/**
		 * Held open because a card is being dragged, rather than because the
		 * traveller opened it. There is nothing to close while a card is in the
		 * air, and a card is what it is waiting for.
		 */
		forced?: boolean;
		/** Which stop a card dropped here lands above. Null is the day's end. */
		before?: string | null;
		/** The day this gap is in, for a card dropped into it. */
		day: number;
		ontoggle: () => void;
		onpick: (at: Date) => void;
	};

	let {
		start,
		end,
		timezone,
		open,
		fillable = true,
		forced = false,
		before = null,
		day,
		ontoggle,
		onpick
	}: Props = $props();

	/**
	 * How tall an open minute is. The gap is drawn to scale, so where the
	 * traveller taps is the time they picked -- a free afternoon opens wide and
	 * a five-minute pause barely parts.
	 */
	const PX_PER_MIN = 1.4;
	/**
	 * A gap under a fingertip cannot be tapped, and a packed day is exactly
	 * where something needs squeezing in. Below this it opens to the tap target
	 * and the label says the real figure, so the scale never lies silently.
	 */
	const MIN_OPEN_PX = 52;
	/** Past this it is a scrollbar, not a gap. */
	const MAX_OPEN_PX = 340;

	const freeMin = $derived(Math.max(0, Math.round((+end - +start) / 60_000)));
	const height = $derived(
		Math.min(MAX_OPEN_PX, Math.max(MIN_OPEN_PX, Math.round(freeMin * PX_PER_MIN)))
	);

	const hhmm = (d: Date) =>
		new Intl.DateTimeFormat(undefined, {
			timeZone: timezone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(d);

	/** Where in the gap they touched, as the moment it stands for. */
	function pick(event: MouseEvent) {
		if (!fillable) return;
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const fraction = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
		onpick(new Date(+start + fraction * (+end - +start)));
	}
</script>

{#if open}
	<div
		class="tm-gap tm-gap--open"
		style="height:{height}px"
		data-drop-gap={fillable ? (before ?? '') : undefined}
		data-gap-day={day}
		data-gap-start={start.toISOString()}
		data-gap-end={end.toISOString()}
	>
		<button
			class="tm-gap__line"
			onclick={pick}
			aria-label={fillable
				? `Add a stop between ${hhmm(start)} and ${hhmm(end)}`
				: `${freeMin} minutes free`}
			disabled={!fillable}
		>
			<span class="tm-gap__edge">{hhmm(start)}</span>
			<span class="tm-gap__free">
				{#if freeMin > 0}
					{freeMin} min free{#if fillable}<span class="tm-gap__hint">
							&nbsp;· tap to add</span
						>{/if}
				{:else}
					back to back
				{/if}
			</span>
			<span class="tm-gap__edge tm-gap__edge--end">{hhmm(end)}</span>
		</button>
		{#if !forced}
			<button class="tm-gap__close" onclick={ontoggle} aria-label="Close the gap">▴</button>
		{/if}
	</div>
{:else}
	<button
		class="tm-gap tm-gap--shut"
		onclick={ontoggle}
		aria-label="Open the gap between {hhmm(start)} and {hhmm(end)}"
	></button>
{/if}

<style>
	.tm-gap {
		display: block;
		width: 100%;
		border: none;
		background: none;
		padding: 0;
		position: relative;
	}

	/* Shut, it is a hairline with a hand's worth of room around it: the day
	   reads as a list of cards, and the space between two of them is a target
	   rather than a control shouting for attention. */
	.tm-gap--shut {
		height: 16px;
		cursor: pointer;
	}
	.tm-gap--shut::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 26px;
		height: 0;
		transform: translate(-50%, -50%);
		border-top: 1px dashed var(--tm-border-strong);
		opacity: 0.6;
	}
	.tm-gap--shut:hover::after {
		opacity: 1;
	}

	.tm-gap--open {
		margin: 2px 0;
	}

	.tm-gap__line {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		gap: 2px;
		padding: 3px 0;
		border: 1px dashed var(--tm-border-strong);
		border-radius: var(--tm-r-md);
		background: repeating-linear-gradient(
			135deg,
			var(--tm-surface-2) 0 6px,
			transparent 6px 12px
		);
		color: var(--tm-text-faint);
		font: 500 var(--tm-text-xs)/1 var(--tm-font);
		cursor: crosshair;
	}
	.tm-gap__line:disabled {
		cursor: default;
	}

	.tm-gap__edge {
		font: 600 10px/1 var(--tm-font-num);
		color: var(--tm-text-faint);
	}
	.tm-gap__edge--end {
		align-self: center;
	}

	.tm-gap__free {
		font: 600 var(--tm-text-xs)/1 var(--tm-font);
		color: var(--tm-text-muted);
	}
	.tm-gap__hint {
		font-weight: 500;
		color: var(--tm-text-faint);
	}

	.tm-gap__close {
		position: absolute;
		top: 2px;
		right: 4px;
		border: none;
		background: none;
		cursor: pointer;
		color: var(--tm-text-faint);
		font-size: 13px;
		line-height: 1;
		padding: 3px 6px;
	}
</style>
