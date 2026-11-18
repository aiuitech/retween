/**
 * The analyser must measure audio that is only reachable over https (signed
 * file links in production). The ffmpeg Remotion ships cannot open https, so
 * this serves the fixture media over https with a throwaway certificate.
 * (The macOS build of that ffmpeg does have TLS, so on a Mac the first test
 * passes either way; the localCopies test is what pins the behaviour.)
 *
 *   node --test renderer/server/          (needs openssl and renderer/fixtures/media: pnpm --dir renderer fixtures)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Timeline } from "../../shared/timeline.ts";
import { analyseAudio, localCopies } from "./audio.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.join(here, "../fixtures/media");
const dir = mkdtempSync(path.join(tmpdir(), "retween-audio-test-"));
let base = "";
let server: ReturnType<typeof createServer>;

before(async () => {
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`], { stdio: "ignore" });
	// The certificate is self-signed; trust it for this process only.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	server = createServer({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, (req, res) => {
		const name = path.basename(new URL(req.url ?? "/", "https://x").pathname);
		try {
			const body = readFileSync(path.join(media, name));
			res.writeHead(200, { "content-length": body.length });
			res.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `https://127.0.0.1:${(server.address() as AddressInfo).port}/api/files/`;
});

after(() => {
	server?.close();
	rmSync(dir, { recursive: true, force: true });
});

const timeline = () => {
	const raw = readFileSync(path.join(here, "../fixtures/timeline.json"), "utf8").replaceAll("asset://", "BASE");
	// Signed links carry a query string; keep one so it is exercised too.
	return Timeline.parse(JSON.parse(raw.replace(/"BASE([^"]+)"/g, (_, name: string) => JSON.stringify(`${base}${name}?sig=abc&exp=1`))));
};

test("measures a prepared video whose audio is served over https", async () => {
	const analysis = await analyseAudio(timeline());
	assert.deepEqual(analysis.skipped, []);
	assert.equal(typeof analysis.mix.lufs, "number");
	assert.ok(analysis.mix.lufs! > -30 && analysis.mix.lufs! < -5, `mix ${analysis.mix.lufs} LUFS`);
	assert.equal(typeof analysis.stems.narration?.lufs, "number");
	assert.equal(typeof analysis.stems.music?.lufs, "number");
	assert.ok(analysis.scenes.some((scene) => typeof scene.narrationLufs === "number"));
});

test("a source that cannot be downloaded is skipped with a reason, without its signature", async () => {
	const broken = timeline();
	broken.audio[0]!.src = `${base}missing.m4a?sig=secret`;
	const analysis = await analyseAudio(broken);
	const skipped = analysis.skipped.find((entry) => entry.id === broken.audio[0]!.id);
	assert.ok(skipped, JSON.stringify(analysis.skipped));
	assert.match(skipped.reason, /404/);
	assert.doesNotMatch(skipped.reason, /secret/);
	assert.equal(typeof analysis.mix.lufs, "number");
});

test("ffmpeg is only ever handed local files", async () => {
	const into = mkdtempSync(path.join(dir, "copies-"));
	const src = `${base}narration-open.m4a?sig=abc`;
	const copies = await localCopies([src, src, "/already/local.wav"], into);
	const local = copies.get(src);
	assert.equal(typeof local, "string");
	assert.ok(!/^[a-z]+:/i.test(local as string) && existsSync(local as string), String(local));
	assert.equal(copies.get("/already/local.wav"), "/already/local.wav");
	assert.equal(copies.size, 2, "each source is downloaded once");
});
