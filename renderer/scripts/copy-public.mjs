// Files the composition loads by URL rather than importing: copied into public/
// (served by Remotion as static files) before bundling or opening the Studio.
//
// - MapLibre's web worker. MapLibre finds it next to its own module through
//   import.meta.url, which webpack rewrites to a file:// path, so the map is
//   told where to load it from instead (see components/MapScene.tsx).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
fs.mkdirSync(pub, { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), path.join(pub, "maplibre-gl-worker.mjs"));
