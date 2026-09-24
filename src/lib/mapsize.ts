/**
 * The size to ask Google for a still map, so the picture has the shape of
 * the box it is shown in.
 *
 * Asked at a fixed 640 wide, a picture set to fill a narrower box was cut at
 * both sides -- and with it the ends of the route the map was drawn to show.
 * Asked at the box's own shape, it is shown whole, and Google's own framing
 * (every marker and the whole path, with a margin) is what the traveller
 * sees. Google draws at most 640 a side (twice that at scale 2), so a wider
 * box keeps its shape at 640 across.
 */
export function mapSize(width: number, height: number): string | null {
	if (width <= 0 || height <= 0) return null;
	const w = Math.min(640, Math.round(width));
	const h = Math.max(1, Math.round((height * w) / width));
	return `${w}x${Math.min(640, h)}`;
}
