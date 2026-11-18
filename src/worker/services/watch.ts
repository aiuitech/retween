/**
 * A second pair of eyes and ears: a model that takes video watches a draft
 * cut and returns timestamped notes, mapped to scenes. It is the one check
 * that hears how the voice actually sounds against the music and sees the
 * motion; everything else works from stills and numbers.
 */
import { clock, round2, sceneAt } from "../../../shared/inspect.ts";
import type { Storyboard } from "../../../shared/storyboard.ts";
import type { Timeline } from "../../../shared/timeline.ts";
import { REVIEW_MODEL, watchVideo } from "../providers/openrouter.ts";
import { sceneSummary } from "./reviews.ts";
import { readObject } from "./storage.ts";
import { recordUsage } from "./usage.ts";

/** Longest stretch sent to the model at once: the file travels inline. */
export const MAX_WATCH_SECONDS = 120;

export interface WatchNote {
	atSec: number;
	at: string;
	sceneId?: string;
	severity: "fix" | "consider";
	kind: string;
	note: string;
}

const SYSTEM = `You are an experienced video editor reviewing a draft cut for a colleague. Watch it and listen to it all the way through, then give specific, actionable notes.

Look and listen for: whether the opening earns attention in its first seconds; narration that sounds wrong (mispronounced words, odd emphasis, a robotic or rushed read, level changes between lines); music fighting the voice or ending abruptly; pictures that do not match what is being said, look wrong (distorted hands or faces, garbled text, artefacts) or stay on screen too long; text that is hard to read or on screen too briefly; transitions that jar; stretches where nothing changes; an ending that just stops.

Do not comment on things that are fine. Do not invent problems. Each note is about one moment.

Answer with JSON only: {"overall": "two or three sentences: what works, and the most important change", "notes": [{"atSec": seconds from the start of this clip, "severity": "fix" (clearly wrong) or "consider" (a judgement call), "kind": one of "opening", "voice", "music", "picture", "text", "pacing", "transition", "ending", "other", "note": "what is wrong and what to do about it"}]}`;

/** What the model is told about the cut, so it can name scenes and knows what was meant. */
function cutSheet(timeline: Timeline, storyboard: Storyboard, from: number, to: number, focus?: string): string {
	const board = new Map(storyboard.scenes.map((scene) => [scene.id, scene]));
	const lines = timeline.scenes
		.filter((scene) => scene.startFrame + scene.durationInFrames > from && scene.startFrame <= to)
		.map((scene) => {
			const start = Math.max(0, (scene.startFrame - from) / timeline.fps);
			const end = (Math.min(to + 1, scene.startFrame + scene.durationInFrames) - from) / timeline.fps;
			const said = board.get(scene.id)?.narration?.trim();
			return `- ${start.toFixed(1)}-${end.toFixed(1)}s, scene "${scene.id}" (${scene.type}): ${sceneSummary(board.get(scene.id))}${said ? ` | script: "${said.slice(0, 300)}"` : ""}`;
		});
	return [
		"The cut, scene by scene (times from the start of this clip), with the script the voice should be reading:",
		...lines,
		focus ? `\nThe colleague asks you to pay particular attention to: ${focus}` : "",
	].join("\n");
}

function parse(text: string): { overall?: string; notes: { atSec?: number; severity?: string; kind?: string; note?: string }[] } {
	const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	try {
		const json = JSON.parse(cleaned) as { overall?: string; notes?: unknown };
		return { overall: typeof json.overall === "string" ? json.overall : undefined, notes: Array.isArray(json.notes) ? json.notes : [] };
	} catch {
		return { overall: cleaned.slice(0, 1500), notes: [] };
	}
}

/**
 * Sends a finished draft (an MP4 in R2 covering frames [from, to] of the
 * timeline) to the model and returns its notes in video time, by scene.
 */
export async function watchDraft(input: {
	key: string;
	timeline: Timeline;
	storyboard: Storyboard;
	frames: [number, number];
	focus?: string;
	usage: { userId: string; projectId: string; videoId: string };
}) {
	const { timeline } = input;
	const [from, to] = input.frames;
	const file = await readObject(input.key);
	const result = await watchVideo({ video: file.bytes, system: SYSTEM, prompt: cutSheet(timeline, input.storyboard, from, to, input.focus) });
	await recordUsage({
		...input.usage,
		kind: "preview",
		provider: "openrouter",
		model: result.model,
		quantity: result.tokens,
		unit: "tokens",
		costUsd: result.costUsd ?? (result.tokens / 1e6) * 1.5,
		basis: result.costUsd === undefined ? "list" : "vendor",
		vendorRef: result.generationId,
		dedupeKey: result.generationId && `openrouter:${result.generationId}`,
	});
	const parsed = parse(result.text);
	const offset = from / timeline.fps;
	const last = (to - from + 1) / timeline.fps;
	const notes: WatchNote[] = parsed.notes
		.filter((note) => typeof note.note === "string" && note.note.trim())
		.map((note) => {
			const local = Math.min(last, Math.max(0, Number(note.atSec) || 0));
			const atSec = round2(offset + local);
			return {
				atSec,
				at: clock(atSec),
				sceneId: sceneAt(timeline, Math.min(timeline.durationInFrames - 1, Math.round(atSec * timeline.fps))).id,
				severity: note.severity === "fix" ? ("fix" as const) : ("consider" as const),
				kind: typeof note.kind === "string" ? note.kind.slice(0, 20) : "other",
				note: note.note!.trim().slice(0, 600),
			};
		})
		.sort((a, b) => (a.severity === b.severity ? a.atSec - b.atSec : a.severity === "fix" ? -1 : 1));
	return { overall: parsed.overall, notes, model: result.model ?? REVIEW_MODEL };
}
