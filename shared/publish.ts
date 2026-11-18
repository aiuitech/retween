/**
 * What goes up with a video: chapters for the description, worked out from
 * the scenes that start one. Pure, no I/O.
 */
import type { Storyboard } from "./storyboard.ts";
import type { Timeline } from "./timeline.ts";

export interface Chapter {
	atSec: number;
	title: string;
}

/** YouTube only shows chapters when there are at least three, the first at 0:00, each at least ten seconds long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

/** 83 → "1:23", 3725 → "1:02:05": the form YouTube recognises in a description. */
export function stamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Chapters from the scenes marked with `chapter`, timed to the timeline.
 * The first is moved to 0:00 (YouTube requires it), chapters that would be
 * shorter than ten seconds are folded into the one before, and `problems`
 * says why YouTube would not show them, if it would not.
 */
export function chaptersFor(timeline: Timeline, storyboard: Storyboard): { chapters: Chapter[]; problems: string[] } {
	const titles = new Map(storyboard.scenes.filter((scene) => scene.chapter?.trim()).map((scene) => [scene.id, scene.chapter!.trim()]));
	if (!titles.size) return { chapters: [], problems: [] };
	const duration = timeline.durationInFrames / timeline.fps;
	const marked = timeline.scenes.filter((scene) => titles.has(scene.id)).map((scene) => ({ atSec: scene.startFrame / timeline.fps, title: titles.get(scene.id)! }));
	const problems: string[] = [];
	const chapters: Chapter[] = [];
	for (const chapter of marked) {
		const previous = chapters.at(-1);
		if (!previous) {
			chapters.push({ atSec: 0, title: chapter.title });
			continue;
		}
		if (chapter.atSec - previous.atSec < MIN_CHAPTER_SECONDS) {
			problems.push(`"${chapter.title}" starts less than ${MIN_CHAPTER_SECONDS}s after "${previous.title}", so it is folded into it.`);
			continue;
		}
		chapters.push({ atSec: Math.floor(chapter.atSec), title: chapter.title });
	}
	const last = chapters.at(-1);
	if (last && chapters.length > 1 && duration - last.atSec < MIN_CHAPTER_SECONDS) {
		problems.push(`"${last.title}" lasts less than ${MIN_CHAPTER_SECONDS}s, so it is folded into the one before.`);
		chapters.pop();
	}
	if (chapters.length < MIN_CHAPTERS) {
		problems.push(`There ${chapters.length === 1 ? "is 1 chapter" : `are ${chapters.length} chapters`}; YouTube needs at least ${MIN_CHAPTERS}, each ${MIN_CHAPTER_SECONDS}s or longer, before it shows them.`);
	}
	return { chapters, problems };
}

/** The chapter list as it goes in a description. Empty when YouTube would not show it. */
export function chapterBlock(chapters: Chapter[]): string {
	if (chapters.length < MIN_CHAPTERS) return "";
	return chapters.map((chapter) => `${stamp(chapter.atSec)} ${chapter.title.replace(/[<>]/g, "")}`).join("\n");
}
