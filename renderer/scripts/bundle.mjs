// Builds the Remotion bundle once (at image build time). The server only ever
// reads the result from ./build - nothing is bundled at request time.
import { bundle } from "@remotion/bundler";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
const out = await bundle({
	entryPoint: path.join(root, "src/index.ts"),
	outDir: path.join(root, "build"),
	rootDir: root,
	enableCaching: false,
	onProgress: (p) => {
		if (p === 100) console.log("[bundle] webpack done");
	},
});
console.log(`[bundle] wrote ${out} in ${Date.now() - started}ms`);
