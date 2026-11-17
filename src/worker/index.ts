import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Actor, actorById, actorFromRequest, assertActive, auth } from "./auth/index.ts";
import { AppError, badRequest } from "./lib/util.ts";
import { opsFor, ops, runOp } from "./ops/index.ts";
import { INLINE_IMAGE, manifestEntry } from "./ops/registry.ts";
import { YOUTUBE_SCOPE, authorizationUrl, exchangeCode, myChannel } from "./providers/youtube.ts";
import { handleMcp } from "./routes/mcp.ts";
import { assetView, createAsset, storeAsset } from "./services/assets.ts";
import { getProject } from "./services/projects.ts";
import { contentTypeFor, kindFor, serveObject, verifySignedUrl, verifyUploadUrl } from "./services/storage.ts";
import { accrueStorage } from "./services/metering.ts";
import { reconcileContainers, reconcileFal } from "./services/reconcile.ts";
import { budgetStatus } from "./services/usage.ts";
import { connectState, readConnectState, saveChannel } from "./services/youtube.ts";

export { Renderer } from "./renderer.ts";
export { AssetWorkflow } from "./workflows/asset.ts";
export { PipelineWorkflow } from "./workflows/pipeline.ts";
export { PublishWorkflow } from "./workflows/publish.ts";
export { RenderWorkflow } from "./workflows/render.ts";

const app = new Hono<{ Variables: { actor: Actor } }>();

app.onError((error, c) => {
	if (error instanceof AppError) {
		return c.json({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, error.status as 400);
	}
	console.error("unhandled error", c.req.method, c.req.path, error);
	return c.json({ ok: false, error: { code: "internal", message: "Something went wrong" } }, 500);
});

// MCP clients and OAuth discovery are called cross-origin and carry no cookies.
const openCors = cors({
	origin: "*",
	allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
	exposeHeaders: ["www-authenticate", "mcp-session-id"],
	maxAge: 86400,
});
app.use("/mcp", openCors);
app.use("/.well-known/*", openCors);
app.use("/api/auth/oauth2/token", openCors);
app.use("/api/auth/oauth2/register", openCors);

// ---------------------------------------------------------------- auth

const authServerMetadata = oauthProviderAuthServerMetadata(auth);
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);
app.get("/.well-known/oauth-authorization-server", (c) => authServerMetadata(c.req.raw));
app.get("/.well-known/oauth-authorization-server/*", (c) => authServerMetadata(c.req.raw));
app.get("/.well-known/openid-configuration", (c) => openIdMetadata(c.req.raw));
app.get("/.well-known/openid-configuration/*", (c) => openIdMetadata(c.req.raw));
app.on(["GET", "HEAD"], ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"], (c) => auth.handler(c.req.raw));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

if (import.meta.env.DEV) {
	// Local development only (compiled out of production builds): sign in as any email without Google.
	app.post("/api/dev/login", async (c) => {
		const { email, name } = await c.req.json<{ email: string; name?: string }>();
		const { db, schema } = await import("./db/client.ts");
		const { superuserEmails } = await import("./auth/index.ts");
		const { eq } = await import("drizzle-orm");
		let user = await db.query.user.findFirst({ where: eq(schema.user.email, email) });
		if (!user) {
			// Mirrors what the sign-up hook does for a Google-verified address.
			const superuser = superuserEmails.includes(email.toLowerCase());
			[user] = await db
				.insert(schema.user)
				.values({
					id: crypto.randomUUID(),
					email,
					name: name ?? email.split("@")[0]!,
					emailVerified: true,
					role: superuser ? "admin" : "user",
					approved: superuser,
					monthlyBudgetCents: 2500,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.returning();
		}
		const context = await auth.$context;
		const session = await context.internalAdapter.createSession(user!.id);
		// Also set the browser cookie so the web app can be used locally.
		const { serializeSignedCookie } = await import("better-call");
		const cookie = context.authCookies.sessionToken;
		c.header("set-cookie", await serializeSignedCookie(cookie.name, session.token, context.secret, cookie.attributes));
		return c.json({ token: session.token, userId: user!.id });
	});
}

// ----------------------------------------------------------------- MCP

app.all("/mcp", (c) => handleMcp(c.req.raw));

// ------------------------------------------------------------ REST API

/** Files are fetched by signed URL: by the render container, by browsers and by agents. */
app.on(["GET", "HEAD"], "/api/files/:key", async (c) => {
	const url = new URL(c.req.url);
	const key = await verifySignedUrl(url);
	if (!key) return c.text("This link has expired or is not valid", 403);
	return serveObject(c.req.raw, key, url.searchParams.get("dl"));
});

/** The signed-in account, including accounts still waiting for approval. */
app.get("/api/v1/me", async (c) => {
	const actor = await actorFromRequest(c.req.raw);
	if (!actor) return c.json({ ok: true, user: null });
	return c.json({
		ok: true,
		user: {
			id: actor.id,
			email: actor.email,
			name: actor.name,
			image: actor.image,
			isAdmin: actor.isAdmin,
			approved: actor.approved,
			banned: actor.banned,
			budget: await budgetStatus(actor),
		},
	});
});

/** The operation manifest. The CLI builds its commands from this. */
app.get("/api/v1/ops", async (c) => {
	const actor = await actorFromRequest(c.req.raw);
	const visible = actor ? opsFor(actor) : ops.filter((op) => !op.admin);
	return c.json({ ok: true, version: 1, operations: visible.map(manifestEntry) });
});

const requireActor = async (request: Request): Promise<Actor> => {
	const actor = await actorFromRequest(request);
	assertActive(actor);
	return actor;
};

app.post("/api/v1/ops/:name", async (c) => {
	// JSON only: a cross-site form cannot send this content type without a preflight, which is not granted.
	if (!c.req.header("content-type")?.includes("application/json")) throw new AppError(415, "Send JSON with Content-Type: application/json", "unsupported_media_type");
	const actor = await requireActor(c.req.raw);
	const input = await c.req.json().catch(() => {
		throw badRequest("The request body must be JSON");
	});
	const result = (await runOp(c.req.param("name"), input, actor)) as Record<string, unknown>;
	// Inline images are for agents; over REST the result carries a URL instead.
	if (result && INLINE_IMAGE in result) delete result[INLINE_IMAGE];
	return c.json({ ok: true, result });
});

/** Stores a request body as a new asset in a project. Shared by both upload routes. */
async function receiveUpload(request: Request, actor: Actor, projectId: string) {
	const project = await getProject(actor, projectId);
	const query = new URL(request.url).searchParams;
	const name = query.get("name") ?? "upload";
	const contentType = contentTypeFor(request.headers.get("content-type"), name);
	if (kindFor(contentType) === "other") {
		throw badRequest(
			contentType === "application/octet-stream"
				? "Could not tell what kind of file this is. Add ?name=<file name with its extension> (e.g. name=logo.png) or send a Content-Type."
				: `Unsupported file type "${contentType}". Upload images, video, audio, fonts or Lottie JSON.`,
		);
	}
	if (!request.body || !request.headers.get("content-length")) throw new AppError(411, "Send the file as the request body with a Content-Length", "length_required");
	const asset = await createAsset({
		projectId: project.id,
		createdBy: actor.id,
		kind: kindFor(contentType),
		name,
		description: query.get("description") ?? undefined,
		source: "upload",
		tags: query.get("tags")?.split(",").map((tag) => tag.trim()).filter(Boolean),
	});
	const stored = await storeAsset(asset, request.body, contentType);
	return { ok: true, result: { asset: await assetView(stored) } };
}

/** Upload a local file as an asset: the raw file is the request body. */
app.put("/api/v1/projects/:projectId/assets", async (c) => {
	const actor = await requireActor(c.req.raw);
	return c.json(await receiveUpload(c.req.raw, actor, c.req.param("projectId")));
});

/**
 * Upload through a signed link from asset.upload_link, with no sign-in: how an
 * agent connected over MCP hands over files it has locally. The file is
 * stored as the user who asked for the link, who must still be active and own
 * the project.
 */
app.put("/api/uploads/:grant", async (c) => {
	const grant = await verifyUploadUrl(new URL(c.req.url));
	if (!grant) throw new AppError(403, "This upload link has expired or is not valid. Ask for a new one with asset.upload_link.", "invalid_link");
	const actor = await actorById(grant.userId, "upload-link");
	assertActive(actor);
	return c.json(await receiveUpload(c.req.raw, actor, grant.projectId));
});

// ------------------------------------------------------------ YouTube

/**
 * Starts connecting a YouTube channel (the link youtube.connect hands out).
 * It needs the browser's own session, and the OAuth state is bound to that
 * user, so a link forwarded by someone else cannot attach a channel to their account.
 */
app.get("/api/youtube/connect", async (c) => {
	const actor = await actorFromRequest(c.req.raw);
	if (!actor || actor.via !== "session") return c.redirect("/connect?youtube=sign-in");
	if (!actor.approved || actor.banned) return c.redirect("/");
	return c.redirect(authorizationUrl(await connectState(actor.id)));
});

app.get("/api/youtube/callback", async (c) => {
	const back = (params: Record<string, string>) => c.redirect(`/connect?${new URLSearchParams(params)}`);
	const failed = (reason: string) => back({ youtube: "error", reason });
	const denied = c.req.query("error");
	if (denied) return failed(denied === "access_denied" ? "Access was not granted, so nothing was connected." : `Google said: ${denied}`);
	const userId = await readConnectState(c.req.query("state") ?? "");
	const actor = await actorFromRequest(c.req.raw);
	if (!userId || !actor || actor.id !== userId) return failed("This link has expired or was started from another account. Start again from this page.");
	const code = c.req.query("code");
	if (!code) return failed("Google did not return an authorisation code.");
	try {
		const tokens = await exchangeCode(code);
		// Google lets people untick individual permissions on the consent screen.
		if (tokens.scope && !tokens.scope.split(" ").includes(YOUTUBE_SCOPE)) {
			return failed("YouTube access was unticked on Google's consent screen. Connect again and allow it.");
		}
		const channel = await myChannel(tokens.accessToken);
		await saveChannel(userId, tokens, channel);
		return back({ youtube: "connected", channel: channel.title });
	} catch (error) {
		if (!(error instanceof AppError)) console.error("youtube connect failed", error);
		return failed(error instanceof AppError ? error.message : "Could not connect the channel. Try again.");
	}
});

app.all("/api/*", (c) => c.json({ ok: false, error: { code: "not_found", message: "No such endpoint" } }, 404));

export default {
	fetch: app.fetch,
	/**
	 * Nightly: charge the day that just ended for storage, then replace metered
	 * costs with billed ones where the vendors have them. Each job runs on its own,
	 * so one failing does not stop the others.
	 */
	async scheduled(controller, _env, ctx) {
		const day = new Date(controller.scheduledTime - 24 * 60 * 60 * 1000);
		const jobs: [string, () => Promise<unknown>][] = [
			["storage", () => accrueStorage(day)],
			["fal reconciliation", reconcileFal],
			["container reconciliation", reconcileContainers],
		];
		ctx.waitUntil(
			(async () => {
				for (const [name, job] of jobs) {
					try {
						console.log(name, await job());
					} catch (error) {
						console.error(`${name} failed`, error instanceof Error ? error.message : error);
					}
				}
			})(),
		);
	},
} satisfies ExportedHandler<Env>;
