/** Deterministic string hash (FNV-1a) and a tiny seeded PRNG - never Math.random(). */
export function hash(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Returns `n` stable pseudo-random numbers in [0, 1) for a seed string. */
export function seeded(seed: string, n: number): number[] {
	let s = hash(seed) || 1;
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		out.push(s / 0x100000000);
	}
	return out;
}
