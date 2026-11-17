// Static server for fixtures/media, standing in for signed asset URLs.
// Deliberately sends no CORS headers (signed bucket URLs usually have none) and
// supports Range requests (media readers ask for byte ranges).
//
//   node fixtures/serve.mjs [port]      default 9000, listens on 0.0.0.0 so a container can reach it
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "media");
const port = Number(process.argv[2] ?? 9000);
const types = { ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".json": "application/json" };

http
	.createServer((req, res) => {
		const name = path.basename(decodeURIComponent(new URL(req.url, "http://x").pathname));
		const file = path.join(root, name);
		if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const { size } = fs.statSync(file);
		const headers = { "content-type": types[path.extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes" };
		const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
		if (m && (m[1] || m[2])) {
			const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
			const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
			if (start > end || start >= size) {
				res.writeHead(416, { "content-range": `bytes */${size}` });
				res.end();
				return;
			}
			res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
			if (req.method === "HEAD") return void res.end();
			fs.createReadStream(file, { start, end }).pipe(res);
			return;
		}
		res.writeHead(200, { ...headers, "content-length": size });
		if (req.method === "HEAD") return void res.end();
		fs.createReadStream(file).pipe(res);
	})
	.listen(port, "0.0.0.0", () => console.log(`fixture media on http://localhost:${port}/`));
