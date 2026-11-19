import { z } from "zod";
import { NOTIFICATION_KINDS, PROJECT_ROLES } from "../db/schema.ts";
import { badRequest } from "../lib/util.ts";
import { NOTIFICATION_INFO, emailSettings, listNotifications, markRead, unreadCount, updateEmailSettings } from "../services/notifications.ts";
import { getProject, roleFor } from "../services/projects.ts";
import { projectAccess, shareProject, unshareProject } from "../services/sharing.ts";
import { defineOp } from "./registry.ts";

const projectId = z.string().describe("Project id (prj_…)");

export const sharingOps = [
	defineOp({
		name: "project.members",
		title: "Who has access",
		description:
			"Who can work in a project: its owner, the people it is shared with and their roles (editor or viewer), and, for the owner, invitations not yet accepted with their links. " +
			"Also your own role in it.",
		input: z.object({ projectId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const role = await roleFor(actor, project);
			return { you: role, ...(await projectAccess(project, { withInvites: role === "owner" })) };
		},
	}),

	defineOp({
		name: "project.share",
		title: "Share project",
		description:
			"Give someone access to a project by email address (owner only). Someone with a Retween account gets access at once and is notified; anyone else is emailed an invitation " +
			"and gets access when they sign up with that address (the reply has the invitation link too, to pass on another way). Sharing with someone again changes their role or re-sends the invitation. " +
			"editor: can change everything except deleting the project and who has access. viewer: can read everything and run checks and previews, but change nothing. " +
			"Paid work is billed to whoever starts it; storage stays with the owner. Ask the person before sharing their project.",
		input: z.object({
			projectId,
			email: z.string().min(3).max(320).describe("The person's email address (the Google account they sign in with)"),
			role: z.enum(PROJECT_ROLES).default("editor"),
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId, "owner");
			return shareProject(actor, project, input.email, input.role);
		},
	}),

	defineOp({
		name: "project.unshare",
		title: "Remove access",
		description:
			"Remove someone's access to a project, or withdraw an invitation (owner only). Anyone can remove themselves: pass your own userId to leave a project shared with you. " +
			"What they made in the project stays in it.",
		input: z
			.object({
				projectId,
				userId: z.string().optional().describe("The person to remove (from project.members)"),
				email: z.string().max(320).optional().describe("Or their email address, which also withdraws an invitation to it"),
				inviteId: z.string().optional().describe("Or an invitation to withdraw (inv_…)"),
			})
			.refine((value) => value.userId || value.email || value.inviteId, { message: "Pass userId, email or inviteId" }),
		destructive: true,
		handler: async (input, { actor }) => {
			const leaving = input.userId === actor.id || (input.email?.trim().toLowerCase() === actor.email.toLowerCase() && !input.inviteId);
			const project = await getProject(actor, input.projectId, leaving ? "viewer" : "owner");
			if (leaving && project.ownerId === actor.id) throw badRequest("You own this project. Delete it instead, or share it with someone else first.");
			return unshareProject(actor, project, leaving ? { userId: actor.id } : input);
		},
	}),

	defineOp({
		name: "notification.list",
		title: "Notifications",
		description:
			"Your notifications, newest first: projects shared with you, people joining your projects, review notes arriving, exports finishing or failing. " +
			"Mark them read with notification.read.",
		input: z.object({
			unreadOnly: z.boolean().default(false),
			limit: z.number().int().min(1).max(200).default(30),
		}),
		readOnly: true,
		handler: async (input, { actor }) => ({
			notifications: await listNotifications(actor.id, input),
			unread: await unreadCount(actor.id),
		}),
	}),

	defineOp({
		name: "notification.read",
		title: "Mark notifications read",
		description: "Mark notifications read: the ones listed, or all of them when no ids are given.",
		input: z.object({ ids: z.array(z.string()).max(200).optional() }),
		handler: async (input, { actor }) => ({ marked: await markRead(actor.id, input.ids), unread: await unreadCount(actor.id) }),
	}),

	defineOp({
		name: "notification.settings",
		title: "Notification emails",
		description: "Which kinds of notification are also sent to you by email, with what each kind covers.",
		input: z.object({}),
		readOnly: true,
		handler: async (_input, { actor }) => {
			const email = await emailSettings(actor.id);
			return { email: NOTIFICATION_KINDS.map((kind) => ({ kind, ...NOTIFICATION_INFO[kind], email: email[kind] })) };
		},
	}),

	defineOp({
		name: "notification.settings_update",
		title: "Change notification emails",
		description: "Turn emails for kinds of notification on or off. Notifications still appear in the web app either way.",
		input: z.object({
			email: z.partialRecord(z.enum(NOTIFICATION_KINDS), z.boolean()).describe('e.g. {"render.finished": true, "review.submitted": false}'),
		}),
		handler: async (input, { actor }) => {
			const email = await updateEmailSettings(actor.id, input.email);
			return { email: NOTIFICATION_KINDS.map((kind) => ({ kind, ...NOTIFICATION_INFO[kind], email: email[kind] })) };
		},
	}),
];
