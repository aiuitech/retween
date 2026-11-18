import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		// The Worker (src/worker/index.ts) is the server: it answers the API and MCP itself and hands pages to TanStack Start.
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		tanstackStart({ srcDirectory: "src/web" }),
		react(),
	],
	server: {
		// The renderer is a separate project with its own build; it must not trigger reloads here.
		watch: { ignored: ["**/renderer/**", "**/cli/dist/**"] },
	},
});
