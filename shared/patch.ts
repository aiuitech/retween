/**
 * Changing part of a scene without sending all of it: a patch is merged into
 * the scene, objects field by field, so `{ text: { heading: "New" } }` keeps
 * the rest of the text. Arrays are replaced whole, and null removes a field.
 * Pure, no I/O.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function mergePatch<T>(base: T, patch: unknown): T {
	if (!isObject(patch)) return (patch === undefined ? base : patch) as T;
	const out: Record<string, unknown> = isObject(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else if (value === undefined) continue;
		else if (isObject(value)) out[key] = mergePatch(out[key], value);
		else out[key] = value;
	}
	return out as T;
}

/** Removes a dotted path ("visual.look.blur", "text.bullets") from a copy of an object. */
export function unsetPath<T>(base: T, path: string): T {
	const [head, ...rest] = path.split(".");
	if (!head || !isObject(base) || !(head in base)) return base;
	const out: Record<string, unknown> = { ...base };
	if (!rest.length) delete out[head];
	else out[head] = unsetPath(out[head], rest.join("."));
	return out as T;
}
