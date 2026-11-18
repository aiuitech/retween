/**
 * Footage processing against small recordings made on the spot with the local
 * ffmpeg: a rotated, variable-frame-rate phone-like clip with a hard cut and a
 * gap in its sound, and a voice memo with no picture.
 *
 *   node --test server/          (from renderer/; needs ffmpeg 7.1+ and ffprobe on PATH)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { footageOutput, runFootage } from "./footage.ts";

const dir = mkdtempSync(path.join(tmpdir(), "retween-footage-test-"));
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
let base = "";
let server: ReturnType<typeof createServer>;

const make = (args: string[]) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
const probe = (file: string) =>
	JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString()) as {
		streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; channels?: number; side_data_list?: unknown[] }[];
		format: { duration: string };
	};

before(async () => {
	// 6 s, 1280x720 at 25 fps with every fifth frame dropped (variable frame rate), a hard cut from a
	// test pattern to flat red at 3 s, and a tone that goes silent from 2.0 to 3.5 s.
	make([
		"-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=3",
		"-f", "lavfi", "-i", "color=c=red:size=1280x720:rate=25:duration=3",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,select='not(eq(mod(n\\,5)\\,0))'[v];[2:a]volume=enable='between(t,2,3.5)':volume=0,aformat=channel_layouts=stereo[a]",
		"-map", "[v]", "-map", "[a]", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(dir, "flat.mp4"),
	]);
	// Shot on its side: a display matrix asks players to turn it 90 degrees.
	make(["-display_rotation", "90", "-i", path.join(dir, "flat.mp4"), "-c", "copy", path.join(dir, "phone.mp4")]);
	make(["-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=44100", "-c:a", "aac", path.join(dir, "memo.m4a")]);
	make(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast", path.join(dir, "take.mp4")]);

	server = createServer((req, res) => {
		const file = path.join(dir, path.basename(new URL(req.url ?? "/", "http://x").pathname));
		if (!existsSync(file)) return void res.writeHead(404).end();
		res.writeHead(200, { "content-length": statSync(file).size });
		createReadStream(file).pipe(res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(() => {
	server?.close();
	rmSync(dir, { recursive: true, force: true });
});

test("a rotated, variable-frame-rate phone clip becomes an upright 30 fps edit master and a mono voice track", async () => {
	const status = await runFootage("test-phone", `${base}phone.mp4?sig=secret`);
	assert.equal(status.state, "done", status.error);
	const result = status.result!;
	assert.ok(Math.abs(result.durationSec - 6) < 0.25, `duration ${result.durationSec}`);
	assert.equal(result.hasVideo, true);
	assert.equal(result.hasAudio, true);
	assert.equal(result.video?.rotation, 270, "a +90 display matrix is a quarter turn counter-clockwise");
	assert.equal(result.video?.variableFrameRate, true);
	assert.deepEqual([result.video?.width, result.video?.height], [720, 1280]);

	const video = footageOutput("test-phone", "video")!;
	const v = probe(video).streams.find((s) => s.codec_type === "video")!;
	assert.equal(v.codec_name, "h264");
	assert.deepEqual([v.width, v.height], [720, 1280], "upright and portrait");
	assert.equal(v.r_frame_rate, "30/1");
	assert.equal(v.avg_frame_rate, "30/1", "constant frame rate");
	assert.ok(!v.side_data_list?.length, "no rotation left for players to apply");
	assert.equal(probe(video).streams.find((s) => s.codec_type === "audio")?.codec_name, "aac");

	const a = probe(footageOutput("test-phone", "audio")!).streams;
	assert.equal(a.length, 1);
	assert.equal(a[0]!.codec_name, "aac");
	assert.equal(a[0]!.channels, 1);
	assert.ok(result.audio && result.audio.lufs !== null && Math.abs(result.audio.lufs + 16) < 1.5, `voice at ${result.audio?.lufs} LUFS`);

	assert.ok(result.shots.some((at) => Math.abs(at - 3) <= 0.2), `shots ${JSON.stringify(result.shots)}`);
	assert.ok(
		result.silences.some(([start, end]) => Math.abs(start - 2) < 0.3 && Math.abs(end - 3.5) < 0.3),
		`silences ${JSON.stringify(result.silences)}`,
	);
});

test("a voice memo produces only the voice track", async () => {
	const status = await runFootage("test-memo", `${base}memo.m4a`);
	assert.equal(status.state, "done", status.error);
	const result = status.result!;
	assert.equal(result.hasVideo, false);
	assert.equal(result.video, undefined);
	assert.ok(Math.abs(result.durationSec - 4) < 0.2, `duration ${result.durationSec}`);
	assert.equal(footageOutput("test-memo", "video"), undefined);
	const a = probe(footageOutput("test-memo", "audio")!).streams[0]!;
	assert.equal(a.channels, 1);
	assert.deepEqual(result.shots, []);
});

test("a single take with no cuts and no sound still processes", async () => {
	const status = await runFootage("test-take", `${base}take.mp4`);
	assert.equal(status.state, "done", status.error);
	assert.deepEqual(status.result!.shots, []);
	assert.equal(status.result!.hasAudio, false);
	assert.equal(footageOutput("test-take", "audio"), undefined);
});

test("a failed download is an error that does not leak the signature", async () => {
	const status = await runFootage("test-missing", `${base}missing.mp4?sig=secret`);
	assert.equal(status.state, "error");
	assert.match(status.error!, /404/);
	assert.doesNotMatch(status.error!, /secret/);
});
