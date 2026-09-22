<script lang="ts">
	import type { Explained } from '$lib/conflict';

	type Props = {
		/** What the traveller did, in their words. */
		name: string;
		lines: Explained;
		/** Keep the change: it is sent again and overwrites what is upstream. */
		onaccept: () => void;
		/** Keep what the trip says: the change is dropped. */
		onreject: () => void;
		onclose: () => void;
	};

	let { name, lines, onaccept, onreject, onclose }: Props = $props();
</script>

<div
	role="presentation"
	style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
	onclick={onclose}
></div>

<div class="tm-sheet" style="position:fixed;z-index:61;max-height:86vh;overflow-y:auto" role="dialog" aria-label="A change of yours was put aside">
	<div class="tm-sheet__grip"></div>
	<p class="tm-card__title mt-2">
		<span class="tm-conflict-mark" aria-hidden="true">!</span>“{name}” was not applied
	</p>
	<p class="tm-card__meta mt-1">
		Someone changed the same thing while this phone was away. The trip shows what they did; your
		change is kept here, and nobody else has seen it.
	</p>

	<ul class="mt-4 flex flex-col gap-3" style="list-style:none;padding:0">
		{#each lines as line}
			<li>
				<p class="tm-label">{line.what}</p>
				<table style="width:100%;border-collapse:collapse;font: 400 var(--tm-text-sm)/1.4 var(--tm-font)">
					<thead>
						<tr style="color:var(--tm-text-faint);text-align:left">
							<th style="font-weight:400"></th>
							<th style="font-weight:400">On the trip</th>
							<th style="font-weight:400">Yours</th>
						</tr>
					</thead>
					<tbody>
						{#each line.changes as c}
							<tr>
								<td style="color:var(--tm-text-muted);padding-right:8px">{c.field}</td>
								<td>{c.now}</td>
								<td style="font-weight:600">{c.yours}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</li>
		{/each}
	</ul>

	<div class="mt-5 flex flex-col gap-2">
		<button class="tm-btn tm-btn--primary tm-btn--block" onclick={onaccept}>
			Accept: use my change
		</button>
		<button class="tm-btn tm-btn--secondary tm-btn--block" onclick={onreject}>
			Reject: keep the trip as it is
		</button>
	</div>
</div>
