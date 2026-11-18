Always use `pnpm` for package management and scripts: never `npm`, `npx`, `yarn` or `bun`. Use `pnpm install`, `pnpm add`, `pnpm <script>`, `pnpm exec`/`pnpm dlx`, and `pnpm --dir renderer …` for the renderer, which is a separate pnpm project with its own lockfile. Use `pnpm run deploy` (bare `pnpm deploy` is a pnpm built-in). Commit `pnpm-lock.yaml` changes; never add a `package-lock.json`.

Upon finishing work, commit directly to #main and include the commit hash in final message.
