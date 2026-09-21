/**
 * Run an async job over each item, at most `limit` in flight.
 *
 * Plain Promise.all would fire every routing request at once, which is how a
 * quota gets spent in one tap; awaiting them one at a time is how a plan takes
 * a minute. Neither is what we want.
 *
 * Results come back in input order regardless of the order they finish in.
 */
export async function pool<T, R>(
	items: T[],
	limit: number,
	job: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;

	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await job(items[i], i);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
