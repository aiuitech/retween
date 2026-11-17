/**
 * The MCP surface: every operation exposed as a tool on a stateless
 * Streamable-HTTP endpoint, protected by OAuth (or an API key).
 */
import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { type Actor, actorById, actorFromRequest, assertActive, auth } from "../auth/index.ts";
import { API_KEY_PREFIX } from "../auth/options.ts";
import { AppError } from "../lib/util.ts";
import { opsFor } from "../ops/index.ts";
import { INLINE_IMAGE, type InlineImage } from "../ops/registry.ts";
import { WORKFLOW_GUIDE } from "../services/brief.ts";

export const toolName = (opName: string) => opName.replace(/\./g, "_");

function buildServer(actor: Actor): McpServer {
	const server = new McpServer(
		{ name: "retween", title: "Retween", version: "1.0.0", websiteUrl: env.APP_URL },
		{ instructions: WORKFLOW_GUIDE },
	);

	// Administration lives in the web app and CLI; keeping it out of the tool list saves agents context.
	for (const op of opsFor(actor).filter((candidate) => !candidate.admin)) {
		server.registerTool(
			toolName(op.name),
			{
				title: op.title,
				description: op.description,
				inputSchema: op.input as z.ZodObject,
				annotations: {
					title: op.title,
					readOnlyHint: op.readOnly ?? false,
					destructiveHint: op.destructive ?? false,
					openWorldHint: op.paid ?? false,
				},
			},
			async (input: unknown) => {
				try {
					const result = (await op.handler(input, { actor })) as Record<string, unknown>;
					const { [INLINE_IMAGE]: image, ...data } = result ?? {};
					const inline = image as InlineImage | undefined;
					return {
						content: [
							...(inline ? [{ type: "image" as const, data: inline.base64, mimeType: inline.mimeType }] : []),
							{ type: "text" as const, text: JSON.stringify(data, null, 2) },
						],
					};
				} catch (error) {
					const message = error instanceof AppError ? error.message : "Something went wrong running this operation";
					if (!(error instanceof AppError)) console.error("op failed", op.name, error);
					return { isError: true, content: [{ type: "text" as const, text: message }] };
				}
			},
		);
	}

	server.registerPrompt(
		"make_video",
		{
			title: "Make a video",
			description: "Plan, produce and export a video in a Retween project.",
			argsSchema: z.object({
				topic: z.string().describe("What the video is about"),
				project: z.string().optional().describe("Project name or id"),
			}),
		},
		({ topic, project }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text:
							`Make a video about: ${topic}\n` +
							(project ? `Use the Retween project "${project}".\n` : "Ask me which Retween project to use, or offer to create one.\n") +
							`\n${WORKFLOW_GUIDE}\n\nShow me the storyboard and the estimate before you run video_prepare.`,
					},
				},
			],
		}),
	);
	return server;
}

const handler = createMcpHandler((ctx) => buildServer(ctx.authInfo?.extra?.actor as Actor));

function jsonRpcError(status: number, message: string): Response {
	return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status });
}

function serve(request: Request, actor: Actor | null, clientId: string): Promise<Response> | Response {
	try {
		assertActive(actor);
	} catch (error) {
		return jsonRpcError(error instanceof AppError ? error.status : 403, error instanceof Error ? error.message : "Forbidden");
	}
	return handler.fetch(request, { authInfo: { token: "", clientId, scopes: [], extra: { actor } } });
}

const withOAuth = requireMcpAuth(
	auth,
	async (request, claims) => serve(request, claims.sub ? await actorById(claims.sub, "oauth") : null, String(claims.azp ?? "oauth")),
	{ resource: `${env.APP_URL}/mcp` },
);

export async function handleMcp(request: Request): Promise<Response> {
	const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
	// Headless agents can use an API key instead of the OAuth flow.
	if (bearer?.startsWith(API_KEY_PREFIX)) {
		const actor = await actorFromRequest(request);
		if (!actor) return jsonRpcError(401, "Invalid API key");
		return serve(request, actor, "api-key");
	}
	return withOAuth(request);
}
