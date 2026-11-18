/**
 * Prompt wording added at generation time, after the spec is keyed, so it can
 * change without regenerating media made before.
 */

/** `#8190E8`, `(#8190E8)`, `#8190E8FF`: colour codes that clip models tend to print as text on the subject. */
const HEX_COLOUR = /\s*\(\s*#[0-9a-f]{6}(?:[0-9a-f]{2})?\s*\)|\s*#[0-9a-f]{6}(?:[0-9a-f]{2})?(?![0-9a-z])/gi;

/** Whether a prompt quotes words meant to be shown, e.g. a sign reading "Open". */
const quotesText = (prompt: string) => /"[^"\n]{1,80}"|“[^”\n]{1,80}”/.test(prompt);

/**
 * A clip prompt as the video model is sent it: colour codes are left out (the
 * colour words beside them stay), and nothing is lettered on screen unless
 * the prompt quotes it.
 */
export function clipPromptForModel(prompt: string): string {
	const cleaned = prompt
		.replace(HEX_COLOUR, "")
		.replace(/[ \t]+([,.;:!?])/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	const text = quotesText(cleaned)
		? "No on-screen text, letters, numbers, captions or logos other than the words quoted above."
		: "No on-screen text, letters, numbers, captions or logos anywhere in the shot.";
	return `${cleaned}\n\n${text}`;
}
