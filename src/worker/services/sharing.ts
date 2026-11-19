/**
 * Sharing a project. The owner shares by email address: someone who already
 * has an account gets access at once (and a notification); anyone else gets
 * an invitation email, and access as soon as they sign up with that address
 * or open the link signed in with it.
 */
import { env } from "cloudflare:workers";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { MemberRole } from "../db/schema.ts";
import { AppError, badRequest, bytesToBase64, newId, notFound } from "../lib/util.ts";
import { sendEmail } from "./email.ts";
import { notify } from "./notifications.ts";
import type { Project } from "./projects.ts";

export type Invite = typeof schema.projectInvites.$inferSelect;

const INVITE_DAYS = 30;
/** Invitation emails one account can send in a day, so the sending domain is not used to spam. */
const INVITES_PER_DAY = 30;
const ROLE_WORDS: Record<MemberRole, string> = { editor: "an editor", viewer: "a viewer" };
const ROLE_POWERS: Record<MemberRole, string> = {
	editor: "You can change the brand kit, storyboards and files, and make and export videos. What you generate is billed to your own account.",
	viewer: "You can see the brand kit, storyboards, files and exports, and run checks and previews, but not change anything.",
};

export const normalEmail = (email: string) => email.trim().toLowerCase();
const nameOf = (person: { name: string; email: string }) => person.name?.trim() || person.email;

// --- the link --------------------------------------------------------------------------

let tokenKey: Promise<CryptoKey> | undefined;
const key = () =>
	(tokenKey ??= crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(`retween-invite-link:${env.BETTER_AUTH_SECRET}`))
		.then((raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));

/** The token in an invitation link: the same every time for the same invitation, and useless for any other. */
async function inviteToken(inviteId: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(`invite:${inviteId}`));
	return bytesToBase64(new Uint8Array(signature).slice(0, 24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const invitePath = async (inviteId: string) => `/invite/${inviteId}?t=${await inviteToken(inviteId)}`;

function same(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The invitation a link points to, if the link's token is right. Expired invitations are returned too, so the page can say so. */
export async function inviteFor(inviteId: string, token: string | undefined): Promise<Invite | null> {
	if (!token) return null;
	const invite = await db.query.projectInvites.findFirst({ where: eq(schema.projectInvites.id, inviteId) });
	if (!invite || !same(token, await inviteToken(invite.id))) return null;
	return invite;
}

// --- who has access ----------------------------------------------------------------------

/** The owner, the people the project is shared with, and (for the owner) invitations not yet accepted. */
export async function projectAccess(project: Project, options: { withInvites: boolean }) {
	const [owner, members, invites] = await Promise.all([
		db.query.user.findFirst({ where: eq(schema.user.id, project.ownerId), columns: { id: true, name: true, email: true, image: true } }),
		db
			.select({
				userId: schema.projectMembers.userId,
				role: schema.projectMembers.role,
				since: schema.projectMembers.createdAt,
				name: schema.user.name,
				email: schema.user.email,
				image: schema.user.image,
			})
			.from(schema.projectMembers)
			.innerJoin(schema.user, eq(schema.user.id, schema.projectMembers.userId))
			.where(eq(schema.projectMembers.projectId, project.id))
			.orderBy(schema.projectMembers.createdAt),
		options.withInvites
			? db.query.projectInvites.findMany({
					where: and(eq(schema.projectInvites.projectId, project.id), isNull(schema.projectInvites.acceptedAt)),
					orderBy: schema.projectInvites.createdAt,
				})
			: [],
	]);
	return {
		owner: owner ? { userId: owner.id, name: owner.name, email: owner.email, image: owner.image } : null,
		members,
		...(options.withInvites
			? {
					invites: await Promise.all(
						invites.map(async (invite) => ({
							id: invite.id,
							email: invite.email,
							role: invite.role,
							sentAt: invite.sentAt,
							expiresAt: invite.expiresAt,
							expired: invite.expiresAt.getTime() < Date.now(),
							link: `${env.APP_URL}${await invitePath(invite.id)}`,
						})),
					),
				}
			: {}),
	};
}

/** The owner and editors of a project: the people who act on what happens in it. */
export async function editorsOf(projectId: string): Promise<string[]> {
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { ownerId: true } });
	if (!project) return [];
	const editors = await db.query.projectMembers.findMany({
		where: and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.role, "editor")),
		columns: { userId: true },
	});
	return [project.ownerId, ...editors.map((member) => member.userId)];
}

// --- sharing -----------------------------------------------------------------------------

export type ShareResult =
	| { status: "added" | "updated" | "unchanged"; member: { userId: string; name: string; email: string; role: MemberRole } }
	| { status: "invited"; invite: { id: string; email: string; role: MemberRole; expiresAt: Date; link: string }; emailed: boolean };

/** Gives someone access to a project by email address, or invites them; sharing again changes the role or sends the invitation again. */
export async function shareProject(actor: Actor, project: Project, rawEmail: string, role: MemberRole): Promise<ShareResult> {
	const email = normalEmail(rawEmail);
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("That is not an email address");
	const person = await db.query.user.findFirst({ where: sql`lower(${schema.user.email}) = ${email}` });
	const projectLink = `/projects/${project.id}`;

	if (person) {
		if (person.id === project.ownerId) throw badRequest(`${email} owns this project already.`);
		const existing = await db.query.projectMembers.findFirst({
			where: and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, person.id)),
		});
		await db
			.delete(schema.projectInvites)
			.where(and(eq(schema.projectInvites.projectId, project.id), eq(schema.projectInvites.email, email), isNull(schema.projectInvites.acceptedAt)));
		const member = { userId: person.id, name: person.name, email: person.email, role };
		if (existing?.role === role) return { status: "unchanged", member };
		if (existing) {
			await db
				.update(schema.projectMembers)
				.set({ role })
				.where(and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, person.id)));
			await notify({
				to: [person.id],
				kind: "project.access_changed",
				title: `You are now ${ROLE_WORDS[role]} of ${project.name}`,
				body: `${nameOf(actor)} changed your access. ${ROLE_POWERS[role]}`,
				link: projectLink,
				projectId: project.id,
				actorId: actor.id,
			});
			return { status: "updated", member };
		}
		await db.insert(schema.projectMembers).values({ projectId: project.id, userId: person.id, role, addedBy: actor.id });
		await notify({
			to: [person.id],
			kind: "project.shared",
			title: `${nameOf(actor)} shared ${project.name} with you`,
			body: `You are ${ROLE_WORDS[role]}. ${ROLE_POWERS[role]}`,
			link: projectLink,
			projectId: project.id,
			actorId: actor.id,
			emailAction: "Open the project",
			replyTo: actor.email,
		});
		return { status: "added", member };
	}

	const [sentToday] = await db
		.select({ n: count() })
		.from(schema.projectInvites)
		.where(and(eq(schema.projectInvites.invitedBy, actor.id), gt(schema.projectInvites.sentAt, new Date(Date.now() - 86_400_000))));
	if ((sentToday?.n ?? 0) >= INVITES_PER_DAY && !actor.isAdmin) {
		throw new AppError(429, `You have sent ${INVITES_PER_DAY} invitations in the last day. Try again tomorrow.`, "rate_limited");
	}
	const now = new Date();
	const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
	const [invite] = await db
		.insert(schema.projectInvites)
		.values({ id: newId("inv"), projectId: project.id, email, role, invitedBy: actor.id, sentAt: now, expiresAt })
		.onConflictDoUpdate({
			target: [schema.projectInvites.projectId, schema.projectInvites.email],
			set: { role, invitedBy: actor.id, sentAt: now, expiresAt, acceptedAt: null, acceptedBy: null, updatedAt: now },
		})
		.returning();
	const link = `${env.APP_URL}${await invitePath(invite!.id)}`;
	const emailed = await sendEmail({
		to: email,
		subject: `${nameOf(actor)} invited you to ${project.name} on Retween`,
		paragraphs: [
			`${nameOf(actor)} (${actor.email}) invited you to work on "${project.name}" on Retween, a video studio that agents operate.`,
			`You will be ${ROLE_WORDS[role]}. ${ROLE_POWERS[role]}`,
			`Sign in with Google as ${email} to accept. The invitation is open for ${INVITE_DAYS} days.`,
		],
		action: { label: "Accept the invitation", url: link },
		footer: `You received this because ${actor.email} entered your address. If you were not expecting it, you can ignore this email.`,
		replyTo: actor.email,
	});
	if (!emailed) await db.update(schema.projectInvites).set({ sentAt: null }).where(eq(schema.projectInvites.id, invite!.id));
	return { status: "invited", invite: { id: invite!.id, email, role, expiresAt, link }, emailed };
}

/** Removes someone's access, or withdraws an invitation. Returns what was removed. */
export async function unshareProject(actor: Actor, project: Project, target: { userId?: string; email?: string; inviteId?: string }) {
	if (target.inviteId || (target.email && !target.userId)) {
		const email = target.email ? normalEmail(target.email) : undefined;
		const withdrawn = await db
			.delete(schema.projectInvites)
			.where(
				and(
					eq(schema.projectInvites.projectId, project.id),
					isNull(schema.projectInvites.acceptedAt),
					target.inviteId ? eq(schema.projectInvites.id, target.inviteId) : eq(schema.projectInvites.email, email!),
				),
			)
			.returning({ id: schema.projectInvites.id, email: schema.projectInvites.email });
		if (withdrawn.length) return { withdrawnInvite: withdrawn[0] };
		if (target.inviteId) throw notFound("Invitation");
	}
	let userId = target.userId;
	if (!userId && target.email) {
		const person = await db.query.user.findFirst({ where: sql`lower(${schema.user.email}) = ${normalEmail(target.email)}`, columns: { id: true } });
		userId = person?.id;
	}
	if (!userId) throw notFound("Person with access");
	const removed = await db
		.delete(schema.projectMembers)
		.where(and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, userId)))
		.returning({ userId: schema.projectMembers.userId });
	if (!removed.length) throw notFound("Person with access");
	if (userId !== actor.id) {
		await notify({
			to: [userId],
			kind: "project.access_changed",
			title: `You no longer have access to ${project.name}`,
			body: `${nameOf(actor)} removed your access. Anything you generated in it stays in the project.`,
			projectId: project.id,
			actorId: actor.id,
		});
	}
	return { removed: userId, left: userId === actor.id };
}

/** Turns an invitation into access for this person, and tells whoever invited them. */
async function acceptInvite(person: { id: string; name: string; email: string }, invite: Invite): Promise<void> {
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, invite.projectId) });
	if (project && project.ownerId !== person.id) {
		// An existing membership keeps its role: the invitation was for someone who had none.
		await db.insert(schema.projectMembers).values({ projectId: invite.projectId, userId: person.id, role: invite.role, addedBy: invite.invitedBy }).onConflictDoNothing();
	}
	await db.update(schema.projectInvites).set({ acceptedAt: new Date(), acceptedBy: person.id }).where(eq(schema.projectInvites.id, invite.id));
	if (project) {
		await notify({
			to: [invite.invitedBy],
			kind: "invite.accepted",
			title: `${nameOf(person)} joined ${project.name}`,
			body: `${person.email} accepted your invitation and is ${ROLE_WORDS[invite.role]}.`,
			link: `/projects/${project.id}/sharing`,
			projectId: project.id,
			actorId: person.id,
		});
	}
}

/** Accepts an invitation from its link, for the signed-in person. Their address has to be the one invited. */
export async function acceptInviteLink(person: { id: string; name: string; email: string }, invite: Invite): Promise<{ projectId: string }> {
	if (invite.acceptedAt) {
		if (invite.acceptedBy === person.id) return { projectId: invite.projectId };
		throw new AppError(409, "This invitation has already been accepted.", "accepted");
	}
	if (invite.expiresAt.getTime() < Date.now()) throw new AppError(410, "This invitation has expired. Ask for a new one.", "expired");
	if (normalEmail(person.email) !== invite.email) {
		throw new AppError(
			403,
			`This invitation is for ${invite.email}, and you are signed in as ${person.email}. Sign in with that address, or ask for an invitation to this one.`,
			"wrong_account",
		);
	}
	await acceptInvite(person, invite);
	return { projectId: invite.projectId };
}

/** Runs when an account is created: every open invitation to its (Google-verified) address becomes access. */
export async function acceptInvitesFor(person: { id: string; name: string; email: string; emailVerified?: boolean | null }): Promise<void> {
	if (!person.emailVerified) return;
	const invites = await db.query.projectInvites.findMany({
		where: and(
			eq(schema.projectInvites.email, normalEmail(person.email)),
			isNull(schema.projectInvites.acceptedAt),
			gt(schema.projectInvites.expiresAt, new Date()),
		),
	});
	for (const invite of invites) await acceptInvite(person, invite);
}
