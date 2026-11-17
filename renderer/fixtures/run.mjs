// Drives a running renderer through its HTTP API with a fixture timeline.
//
//   node fixtures/run.mjs still  [--frames 30,200] [--aspects 16:9,9:16,1:1,4:5] [--res 720p] [--scale 1]
//   node fixtures/run.mjs render [--aspect 16:9] [--res 720p] [--crf 20] [--concurrency 4]
//
// Common flags:
//   --server    renderer base URL                 (default http://localhost:8080)
//   --media     base URL the renderer fetches media from (default http://localhost:9000;
//               use http://host.docker.internal:9000 when the renderer runs in Docker)
//   --timeline  fixture file                      (default timeline.json)
//   --out       output directory                  (default fixtures/out)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dimensionsFor, resolveAssetRefs } from "../../shared/timeline.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode = "still", ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];

const server = flags.server ?? "http://localhost:8080";
const mediaBase = (flags.media ?? "http://localhost:9000").replace(/\/$/, "");
const timelineFile = flags.timeline ?? "timeline.json";
const outDir = path.resolve(flags.out ?? path.join(here, "out"));
const res = flags.res ?? "720p";
fs.mkdirSync(outDir, { recursive: true });

const raw = JSON.parse(fs.readFileSync(path.resolve(here, timelineFile), "utf8"));
// The same swap the Worker does: asset://<id> -> a fetchable URL (signed, in production).
const timeline = resolveAssetRefs(raw, (id) => `${mediaBase}/${id}`);
const propsFor = (aspect) => ({ timeline, ...dimensionsFor(aspect, res) });
const tag = path.basename(timelineFile, ".json").replace(/^timeline\.?/, "") || "main";
const post = (route, body) => fetch(`${server}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

if (mode === "still") {
	const aspects = (flags.aspects ?? "16:9,9:16,1:1,4:5").split(",");
	const frames = (flags.frames ?? "30").split(",").map(Number);
	for (const aspect of aspects) {
		for (const frame of frames) {
			const started = Date.now();
			const r = await post("/still", { props: propsFor(aspect), frame, format: flags.format ?? "jpeg", scale: Number(flags.scale ?? 1) });
			if (!r.ok) {
				console.error(`still ${aspect} f${frame}: HTTP ${r.status} ${await r.text()}`);
				process.exitCode = 1;
				continue;
			}
			const file = path.join(outDir, `${tag}-${aspect.replace(":", "x")}-f${String(frame).padStart(4, "0")}.${flags.format === "png" ? "png" : "jpg"}`);
			fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
			const warning = r.headers.get("x-render-warning");
			console.log(`${file}  ${Date.now() - started}ms${warning ? `  warnings: ${decodeURIComponent(warning)}` : ""}`);
		}
	}
} else if (mode === "render") {
	const aspect = flags.aspect ?? "16:9";
	const jobId = `fixture-${tag}-${aspect.replace(":", "x")}-${res}-${Date.now()}`;
	const options = {};
	if (flags.crf) options.crf = Number(flags.crf);
	if (flags.concurrency) options.concurrency = Number(flags.concurrency);
	const r = await post("/render", { jobId, props: propsFor(aspect), options });
	console.log(`POST /render -> ${r.status} ${await r.text()}`);
	if (r.status !== 202) process.exit(1);

	const started = Date.now();
	let last = "";
	let status;
	for (;;) {
		status = await (await fetch(`${server}/status`)).json();
		const line = `${status.state} ${status.stage} ${(status.progress * 100).toFixed(0)}% ${status.renderedFrames}/${status.totalFrames}`;
		if (line !== last) console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s  ${line}`);
		last = line;
		if (status.state !== "rendering") break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	console.log(JSON.stringify(status, null, 2));
	if (status.state !== "done") process.exit(1);

	// Pull the file the way the Worker does: in ranged chunks.
	const chunk = Number(flags.chunk ?? 16 * 1024 * 1024);
	const file = path.join(outDir, `${tag}-${aspect.replace(":", "x")}-${res}.mp4`);
	const fd = fs.openSync(file, "w");
	for (let offset = 0; offset < status.output.bytes; offset += chunk) {
		const end = Math.min(status.output.bytes, offset + chunk) - 1;
		const part = await fetch(`${server}/output`, { headers: { range: `bytes=${offset}-${end}` } });
		if (part.status !== 206) throw new Error(`range ${offset}-${end}: HTTP ${part.status}`);
		const expected = `bytes ${offset}-${end}/${status.output.bytes}`;
		if (part.headers.get("content-range") !== expected) throw new Error(`content-range was ${part.headers.get("content-range")}, expected ${expected}`);
		fs.writeSync(fd, Buffer.from(await part.arrayBuffer()));
	}
	fs.closeSync(fd);
	console.log(`${file}  ${fs.statSync(file).size} bytes in ${Math.ceil(status.output.bytes / chunk)} range request(s), total ${((Date.now() - started) / 1000).toFixed(1)}s`);
} else {
	console.error(`unknown mode "${mode}" (use "still" or "render")`);
	process.exit(1);
}
