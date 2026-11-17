import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: {
		// The renderer is a separate project with its own build; it must not trigger reloads here.
		watch: { ignored: ["**/renderer/**", "**/cli/dist/**"] },
	},
});
