import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

const WORKER = "retween";

/** Remotion + headless Chrome. One instance per render; sized for 1080p/4K frames. */
const renderer = defineContainer({
	name: "retween-renderer",
	image: { dockerfile: "./renderer/Dockerfile", buildContext: "." },
	instanceType: "standard-4",
	maxInstances: 8,
});

export default defineConfig(({ mode }) => {
	const dev = mode === "development";
	return {
		accountId: "797ac9a450f9bde8b6f44e405394b59b",
		worker: {
			name: WORKER,
			entrypoint,
			compatibilityDate: "2026-11-01",
			compatibilityFlags: ["nodejs_compat"],
			domains: ["retween.app"],
			workersDev: false,
			previewUrls: false,
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/mcp", "/.well-known/*"],
			},
			observability: { enabled: true },
			limits: { cpuMs: 300_000 },
			env: {
				APP_URL: bindings.text(dev ? "http://localhost:5173" : "https://retween.app"),
				/** Comma-separated. These accounts become admins the first time they sign in. */
				SUPERUSER_EMAILS: bindings.text("greg@aiui.tech"),
				/** Monthly generation budget given to new users, in US cents. */
				DEFAULT_MONTHLY_BUDGET_CENTS: bindings.text("2500"),
				/** Sent with requests to stock-media APIs. */
				OUTBOUND_USER_AGENT: bindings.text("video-service/1.0"),

				DB: bindings.d1({ name: "retween", id: "202514c9-ef9c-4055-a818-9147862d5554" }),
				MEDIA: bindings.r2({ name: "retween-media" }),
				RENDERER: bindings.durableObject({ worker: WORKER, exportName: "Renderer" }),
				// Local development talks to a renderer started with `npm run renderer` instead of a container.
				...(dev ? { DEV_RENDERER_URL: bindings.text("http://localhost:8099") } : {}),
				ASSET_WORKFLOW: bindings.workflow({ name: "retween-asset", worker: WORKER, exportName: "AssetWorkflow" }),
				PIPELINE_WORKFLOW: bindings.workflow({ name: "retween-pipeline", worker: WORKER, exportName: "PipelineWorkflow" }),
				RENDER_WORKFLOW: bindings.workflow({ name: "retween-render", worker: WORKER, exportName: "RenderWorkflow" }),
				PUBLISH_WORKFLOW: bindings.workflow({ name: "retween-publish", worker: WORKER, exportName: "PublishWorkflow" }),

				BETTER_AUTH_SECRET: bindings.secret(),
				GOOGLE_CLIENT_ID: bindings.secret(),
				GOOGLE_CLIENT_SECRET: bindings.secret(),
				OPENROUTER_API_KEY: bindings.secret(),
				ELEVENLABS_API_KEY: bindings.secret(),
			},
			exports: {
				Renderer: exports.durableObject({ storage: "sqlite", ...(dev ? {} : { container: renderer }) }),
				AssetWorkflow: exports.workflow({ name: "retween-asset" }),
				PipelineWorkflow: exports.workflow({ name: "retween-pipeline" }),
				RenderWorkflow: exports.workflow({ name: "retween-render" }),
				PublishWorkflow: exports.workflow({ name: "retween-publish" }),
			},
		},
		containers: dev ? [] : [renderer],
	};
});
