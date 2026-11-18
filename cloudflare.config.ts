import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

const WORKER = "retween";

/** Remotion + headless Chrome. One instance per render; sized for 1080p/4K frames. */
const renderer = defineContainer({
	name: "retween-renderer",
	image: { dockerfile: "./renderer/Dockerfile", buildContext: "." },
	instanceType: "standard-4",
	maxInstances: 8,
});

const ACCOUNT_ID = "797ac9a450f9bde8b6f44e405394b59b";

export default defineConfig(({ mode }) => {
	const dev = mode === "development";
	return {
		accountId: ACCOUNT_ID,
		worker: {
			name: WORKER,
			entrypoint,
			compatibilityDate: "2026-11-01",
			compatibilityFlags: ["nodejs_compat"],
			domains: ["retween.app"],
			workersDev: false,
			previewUrls: false,
			observability: { enabled: true },
			limits: { cpuMs: 300_000 },
			// Nightly: charge each account a day of storage (services/metering.ts) and of hosted videos' storage and plays
			// (services/hosting.ts), reconcile costs,
			// and from the 2nd of the month invoice the month that closed (services/billing.ts).
			triggers: [triggers.scheduled({ schedule: "10 0 * * *" })],
			env: {
				APP_URL: bindings.text(dev ? "http://localhost:5173" : "https://retween.app"),
				/** Comma-separated. These accounts become admins the first time they sign in, and alone can grant credit and run invoicing. */
				SUPERUSER_EMAILS: bindings.text("greg@aiui.tech"),
				/** Monthly spend cap given to every new account, in billed US cents (markup included). Administrators can change it per account. */
				DEFAULT_MONTHLY_BUDGET_CENTS: bindings.text("1000"),
				/** People are billed vendor cost × this at the end of each month. */
				BILLING_MARKUP: bindings.text("1.4"),
				/** Used to read container usage from Cloudflare's analytics when reconciling costs. */
				CLOUDFLARE_ACCOUNT_ID: bindings.text(ACCOUNT_ID),
				/** Most ElevenLabs requests (narration, sound effects, music) one video's preparation runs at once. Match the plan's concurrency limit (Creator: 3, Pro: 5). */
				ELEVENLABS_CONCURRENCY: bindings.text("3"),
				/** Sent with requests to stock-media APIs. */
				OUTBOUND_USER_AGENT: bindings.text("video-service/1.0"),

				DB: bindings.d1({ name: "retween", id: "202514c9-ef9c-4055-a818-9147862d5554" }),
				MEDIA: bindings.r2({ name: "retween-media" }),
				RENDERER: bindings.durableObject({ worker: WORKER, exportName: "Renderer" }),
				// Local development talks to a renderer started with `pnpm renderer` instead of a container.
				...(dev ? { DEV_RENDERER_URL: bindings.text("http://localhost:8099") } : {}),
				ASSET_WORKFLOW: bindings.workflow({ name: "retween-asset", worker: WORKER, exportName: "AssetWorkflow" }),
				PIPELINE_WORKFLOW: bindings.workflow({ name: "retween-pipeline", worker: WORKER, exportName: "PipelineWorkflow" }),
				RENDER_WORKFLOW: bindings.workflow({ name: "retween-render", worker: WORKER, exportName: "RenderWorkflow" }),
				PUBLISH_WORKFLOW: bindings.workflow({ name: "retween-publish", worker: WORKER, exportName: "PublishWorkflow" }),
				FOOTAGE_WORKFLOW: bindings.workflow({ name: "retween-footage", worker: WORKER, exportName: "FootageWorkflow" }),
				HOSTING_WORKFLOW: bindings.workflow({ name: "retween-hosting", worker: WORKER, exportName: "HostingWorkflow" }),
				/** Hosted videos (services/hosting.ts): copies of renders played from /v/<id> and /embed/<id>. */
				STREAM: bindings.stream(),

				BETTER_AUTH_SECRET: bindings.secret(),
				GOOGLE_CLIENT_ID: bindings.secret(),
				GOOGLE_CLIENT_SECRET: bindings.secret(),
				OPENROUTER_API_KEY: bindings.secret(),
				ELEVENLABS_API_KEY: bindings.secret(),
				/** A restricted key (rk_…) with write access to Customers, Checkout Sessions, Setup Intents, Invoices, Invoice Items and the Customer Portal, and read access to Charges. */
				STRIPE_SECRET_KEY: bindings.secret(),
				/** The signing secret of the webhook endpoint at /api/stripe/webhook. */
				STRIPE_WEBHOOK_SECRET: bindings.secret(),
			},
			exports: {
				Renderer: exports.durableObject({ storage: "sqlite", ...(dev ? {} : { container: renderer }) }),
				AssetWorkflow: exports.workflow({ name: "retween-asset" }),
				PipelineWorkflow: exports.workflow({ name: "retween-pipeline" }),
				RenderWorkflow: exports.workflow({ name: "retween-render" }),
				PublishWorkflow: exports.workflow({ name: "retween-publish" }),
				FootageWorkflow: exports.workflow({ name: "retween-footage" }),
				HostingWorkflow: exports.workflow({ name: "retween-hosting" }),
			},
		},
		containers: dev ? [] : [renderer],
	};
});
