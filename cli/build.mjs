/**
 * Bundles the CLI into a single file and packs it as an npm tarball that the
 * service hosts itself:
 *
 *     npm install -g https://retween.app/cli/retween.tgz
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const stage = join(here, "dist");
const pkg = join(stage, "package");

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(pkg, "bin"), { recursive: true });

await build({
	entryPoints: [join(here, "src/index.ts")],
	outfile: join(pkg, "bin/retween.mjs"),
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	minify: false,
	banner: { js: "#!/usr/bin/env node" },
	define: {
		__VERSION__: JSON.stringify(version),
		__DEFAULT_URL__: JSON.stringify(process.env.RETWEEN_URL ?? "https://retween.app"),
	},
});
chmodSync(join(pkg, "bin/retween.mjs"), 0o755);

writeFileSync(
	join(pkg, "package.json"),
	`${JSON.stringify(
		{
			name: "retween",
			version,
			description: "Command-line interface for Retween",
			type: "module",
			bin: { retween: "bin/retween.mjs" },
			engines: { node: ">=20" },
			license: "UNLICENSED",
		},
		null,
		2,
	)}\n`,
);

// Vite copies public/ into the deployed assets, so the tarball is served at /cli/retween.tgz.
const out = join(root, "public/cli");
mkdirSync(out, { recursive: true });
execFileSync("tar", ["-czf", join(out, "retween.tgz"), "-C", stage, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(`cli ${version} → public/cli/retween.tgz`);
