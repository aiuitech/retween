/**
 * Levelling a finished export (master.ts) with real ffmpeg:
 *   node --test server/master.test.ts      (from renderer/; needs ffmpeg on PATH)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { masterLoudness } from "./master.ts";

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retween-master-"));
const make = (file: string, args: string[]) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, file], { stdio: ["ignore", "ignore", "pipe"] });

test("a quiet export is levelled to the target and its picture is kept", async () => {
	const file = path.join(dir, "quiet.mp4");
	// Ten seconds of a tone about 20 dB down, under a small test picture: much like a -20 LUFS narration mix.
	make(file, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-af", "volume=-20dB", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
	const before = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file]).toString();
	const result = await masterLoudness(file, { lufs: -14, truePeak: -1 });
	assert.ok(result, "levelled");
	assert.ok(result.inputLufs! < -20, `input ${result.inputLufs}`);
	assert.ok(Math.abs(result.outputLufs! + 14) <= 1, `output ${result.outputLufs}`);
	assert.ok(result.outputTruePeak! <= -0.9, `peak ${result.outputTruePeak}`);
	const after = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file]).toString();
	assert.equal(after, before, "same streams after levelling");
});

test("a silent soundtrack is left alone", async () => {
	const file = path.join(dir, "silent.mp4");
	make(file, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3"]);
	const size = fs.statSync(file).size;
	assert.equal(await masterLoudness(file, { lufs: -14, truePeak: -1 }), null);
	assert.equal(fs.statSync(file).size, size);
});
