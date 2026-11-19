/**
 * Server functions for the invitation page. It is opened from an email link by
 * someone who may not have an account yet, so these do not go through the
 * operations (which need an account in good standing): the link's token is what
 * lets a request see one invitation, and accepting it needs only a signed-in session.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { actorFromRequest } from "../worker/auth/index.ts";
import { db, schema } from "../worker/db/client.ts";
import { AppError } from "../worker/lib/util.ts";
import { acceptInviteLink, inviteFor } from "../worker/services/sharing.ts";

export type InviteReply<T> = { ok: true; value: T } | { ok: false; message: string; status: number };

export interface InvitePage {
	projectName: string;
	from: string;
	email: string;
	role: "editor" | "viewer";
	state: "open" | "expired" | "accepted" | "yours";
	projectId?: string;
	signedInAs?: string;
}

async function reply<T>(work: () => Promise<T>): Promise<InviteReply<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		if (error instanceof AppError) return { ok: false, message: error.message, status: error.status };
		console.error("invite page", error);
		return { ok: false, message: "Something went wrong. Try again in a moment.", status: 500 };
	}
}

const clean = (data: { inviteId: string; token?: string }) => ({
	inviteId: String(data.inviteId).slice(0, 40),
	token: typeof data.token === "string" ? data.token.slice(0, 100) : undefined,
});

async function load(inviteId: string, token: string | undefined) {
	const invite = await inviteFor(inviteId, token);
	if (!invite) throw new AppError(404, "This invitation link is not valid. It may have been withdrawn: ask for a new one.", "not_found");
	return invite;
}

export const loadInvite = createServerFn({ method: "GET" })
	.validator(clean)
	.handler(({ data }) =>
		reply(async (): Promise<InvitePage> => {
			const invite = await load(data.inviteId, data.token);
			const [project, inviter, actor] = await Promise.all([
				db.query.projects.findFirst({ where: eq(schema.projects.id, invite.projectId), columns: { name: true } }),
				db.query.user.findFirst({ where: eq(schema.user.id, invite.invitedBy), columns: { name: true, email: true } }),
				actorFromRequest(getRequest()).catch(() => null),
			]);
			if (!project) throw new AppError(404, "The project this invitation was for no longer exists.", "not_found");
			const state = invite.acceptedAt
				? invite.acceptedBy === actor?.id
					? "yours"
					: "accepted"
				: invite.expiresAt.getTime() < Date.now()
					? "expired"
					: "open";
			return {
				projectName: project.name,
				from: inviter?.name || inviter?.email || "Someone",
				email: invite.email,
				role: invite.role,
				state,
				...(state === "yours" ? { projectId: invite.projectId } : {}),
				...(actor ? { signedInAs: actor.email } : {}),
			};
		}),
	);

export const acceptInvite = createServerFn({ method: "POST" })
	.validator(clean)
	.handler(({ data }) =>
		reply(async () => {
			const actor = await actorFromRequest(getRequest());
			if (!actor) throw new AppError(401, "Sign in to accept the invitation.", "unauthenticated");
			if (actor.banned) throw new AppError(403, "This account is suspended.", "suspended");
			return acceptInviteLink(actor, await load(data.inviteId, data.token));
		}),
	);
