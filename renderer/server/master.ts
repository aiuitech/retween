/**
 * Levels a finished export's soundtrack to a loudness target: two-pass EBU R128
 * loudnorm (measure, then apply in linear mode where the target allows it), with
 * true peaks held under the ceiling. The picture is copied untouched; only the
 * audio is re-encoded.
 *
 * Uses real ffmpeg from PATH (FFMPEG_PATH overrides): the build Remotion ships
 * has no loudnorm worth using.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/** Loudness range loudnorm aims for; speech-led video sits well inside it, so it rarely compresses. */
const LRA = 11;
const AUDIO_BITRATE = "192k";

export interface MasterTarget {
	lufs: number;
	truePeak: number;
}

export interface MasterResult {
	/** Integrated loudness before and after, LUFS. */
	inputLufs: number | null;
	outputLufs: number | null;
	inputTruePeak: number | null;
	outputTruePeak: number | null;
	/** linear: one gain for the whole file. dynamic: loudnorm had to compress to meet the target. */
	mode: "linear" | "dynamic";
}

function ffmpeg(args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-nostats", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`))));
	});
}

/** The JSON report loudnorm prints last. */
function report(stderr: string): Record<string, string> | null {
	const end = stderr.lastIndexOf("}");
	const start = stderr.lastIndexOf("{", end);
	if (start < 0 || end < 0) return null;
	try {
		return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
	} catch {
		return null;
	}
}

const num = (value: string | undefined): number | null => {
	const n = Number(value);
	return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

/**
 * Rewrites `file` in place with its audio levelled to `target`. Returns null,
 * leaving the file as it was, when the soundtrack is silent.
 */
export async function masterLoudness(file: string, target: MasterTarget, signal?: AbortSignal): Promise<MasterResult | null> {
	const filter = `loudnorm=I=${target.lufs}:TP=${target.truePeak}:LRA=${LRA}`;
	const measured = report(await ffmpeg(["-i", file, "-map", "0:a:0", "-af", `${filter}:print_format=json`, "-f", "null", "-"], signal));
	const inputLufs = num(measured?.input_i);
	// Silence (or no measurable programme) has nothing to level.
	if (!measured || inputLufs === null || inputLufs < -70) return null;

	const out = `${file}.master.mp4`;
	try {
		const applied = report(
			await ffmpeg(
				[
					"-y",
					"-i",
					file,
					"-map",
					"0:v?",
					"-map",
					"0:a:0",
					"-c:v",
					"copy",
					"-af",
					`${filter}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`,
					// loudnorm works at 192 kHz internally; bring it back to the usual rate.
					"-ar",
					"48000",
					"-c:a",
					"aac",
					"-b:a",
					AUDIO_BITRATE,
					"-movflags",
					"+faststart",
					out,
				],
				signal,
			),
		);
		fs.renameSync(out, file);
		return {
			inputLufs,
			outputLufs: num(applied?.output_i),
			inputTruePeak: num(measured.input_tp),
			outputTruePeak: num(applied?.output_tp),
			mode: applied?.normalization_type === "dynamic" ? "dynamic" : "linear",
		};
	} finally {
		fs.rmSync(out, { force: true });
	}
}
