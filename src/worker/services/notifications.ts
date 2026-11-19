/**
 * Notifications: a row per person in the web app's inbox, and an email unless
 * the person turned that kind of email off (account → Notifications).
 */
import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { NOTIFICATION_KINDS, type NotificationKind } from "../db/schema.ts";
import { newId } from "../lib/util.ts";
import { sendEmail } from "./email.ts";

export const NOTIFICATION_INFO: Record<NotificationKind, { label: string; description: string; email: boolean }> = {
	"project.shared": { label: "Projects shared with you", description: "Someone gives you access to a project.", email: true },
	"project.access_changed": { label: "Access changes", description: "Your role in a project changes, or your access is removed.", email: true },
	"invite.accepted": { label: "Invitations accepted", description: "Someone you invited joins your project.", email: true },
	"review.submitted": { label: "Review notes", description: "A reviewer sends notes on a video in a project you can edit.", email: true },
	"render.finished": { label: "Exports finished", description: "An export you started is ready to download.", email: false },
	"render.failed": { label: "Exports failed", description: "An export you started could not be made.", email: true },
};

export type Notification = typeof schema.notifications.$inferSelect;

export async function emailSettings(userId: string): Promise<Record<NotificationKind, boolean>> {
	const row = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.userId, userId) });
	return Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, row?.email[kind] ?? NOTIFICATION_INFO[kind].email])) as Record<NotificationKind, boolean>;
}

export async function updateEmailSettings(userId: string, change: Partial<Record<NotificationKind, boolean>>) {
	const row = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.userId, userId) });
	const email = { ...row?.email };
	for (const kind of NOTIFICATION_KINDS) {
		const value = change[kind];
		if (value === undefined) continue;
		// Only differences from the default are kept, so a changed default reaches everyone who never touched it.
		if (value === NOTIFICATION_INFO[kind].email) delete email[kind];
		else email[kind] = value;
	}
	await db
		.insert(schema.notificationSettings)
		.values({ userId, email })
		.onConflictDoUpdate({ target: schema.notificationSettings.userId, set: { email, updatedAt: new Date() } });
	return emailSettings(userId);
}

export interface NotifyInput {
	/** Who hears about it. Duplicates are dropped. */
	to: string[];
	kind: NotificationKind;
	/** One line, e.g. "Ana shared Spring launch with you". */
	title: string;
	body?: string;
	/** A path in the web app. */
	link?: string;
	projectId?: string;
	actorId?: string;
	/** Paragraphs for the email, when they should say more than the title and body. */
	emailParagraphs?: string[];
	emailAction?: string;
	/** Where replies to the email go, e.g. the person who shared a project. */
	replyTo?: string;
}

/**
 * Records a notification for each recipient and emails those who want this
 * kind by email. Never throws: a notification is a side effect of work that already happened.
 */
export async function notify(input: NotifyInput): Promise<void> {
	try {
		const to = [...new Set(input.to)].filter(Boolean);
		if (!to.length) return;
		const rows = to.map((userId) => ({
			id: newId("ntf"),
			userId,
			kind: input.kind,
			title: input.title.slice(0, 300),
			body: input.body?.slice(0, 2000) ?? null,
			link: input.link ?? null,
			projectId: input.projectId ?? null,
			actorId: input.actorId ?? null,
		}));
		await db.insert(schema.notifications).values(rows);

		const people = await db.query.user.findMany({ where: inArray(schema.user.id, to), columns: { id: true, email: true, banned: true } });
		for (const person of people) {
			if (person.banned || !(await emailSettings(person.id))[input.kind]) continue;
			const sent = await sendEmail({
				to: person.email,
				subject: input.title,
				paragraphs: input.emailParagraphs ?? [input.title, ...(input.body ? [input.body] : [])],
				action: input.link ? { label: input.emailAction ?? "Open in Retween", url: `${env.APP_URL}${input.link}` } : undefined,
				footer: `You get this email because "${NOTIFICATION_INFO[input.kind].label}" emails are on. Change which emails you get at ${env.APP_URL}/account/notifications`,
				replyTo: input.replyTo,
			});
			const row = rows.find((candidate) => candidate.userId === person.id)!;
			if (sent) await db.update(schema.notifications).set({ emailedAt: new Date() }).where(eq(schema.notifications.id, row.id));
		}
	} catch (error) {
		console.error("notification not recorded", input.kind, error);
	}
}

export async function listNotifications(userId: string, options: { unreadOnly?: boolean; limit?: number } = {}) {
	const rows = await db.query.notifications.findMany({
		where: and(eq(schema.notifications.userId, userId), options.unreadOnly ? isNull(schema.notifications.readAt) : undefined),
		orderBy: desc(schema.notifications.createdAt),
		limit: options.limit ?? 50,
	});
	return rows.map(notificationView);
}

export function notificationView(row: Notification) {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		...(row.body ? { body: row.body } : {}),
		...(row.link ? { link: row.link, url: `${env.APP_URL}${row.link}` } : {}),
		...(row.projectId ? { projectId: row.projectId } : {}),
		read: row.readAt !== null,
		emailed: row.emailedAt !== null,
		createdAt: row.createdAt,
	};
}

export async function unreadCount(userId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(schema.notifications)
		.where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
	return row?.n ?? 0;
}

/** Marks some (or, without ids, all) of a person's notifications read. Returns how many changed. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
	const changed = await db
		.update(schema.notifications)
		.set({ readAt: new Date() })
		.where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), ids ? inArray(schema.notifications.id, ids) : undefined))
		.returning({ id: schema.notifications.id });
	return changed.length;
}
