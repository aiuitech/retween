import { and, count, desc, eq, inArray } from "drizzle-orm";
import { BrandKit } from "../../../shared/brand.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { MemberRole } from "../db/schema.ts";
import { forbidden, notFound } from "../lib/util.ts";
import { notSceneMedia } from "./assets.ts";

export type Project = typeof schema.projects.$inferSelect;

/** What a person may do in a project. See `PROJECT_ROLES`. */
export type ProjectRole = "owner" | MemberRole;
const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (role: ProjectRole | null, need: ProjectRole) => role !== null && RANK[role] >= RANK[need];

/** A person's role in a project, or null when it is not shared with them. */
export async function roleOf(userId: string, project: Pick<Project, "id" | "ownerId">): Promise<ProjectRole | null> {
	if (project.ownerId === userId) return "owner";
	const member = await db.query.projectMembers.findFirst({
		where: and(eq(schema.projectMembers.projectId, project.id), eq(schema.projectMembers.userId, userId)),
		columns: { role: true },
	});
	return member?.role ?? null;
}

/** The actor's role in a project. Administrators can do anything in any project, as its owner can. */
export async function roleFor(actor: Actor, project: Pick<Project, "id" | "ownerId">): Promise<ProjectRole | null> {
	const role = await roleOf(actor.id, project);
	return role ?? (actor.isAdmin ? "owner" : null);
}

/**
 * The project, if the actor has at least the role `need` in it. Without `need`,
 * operations that only read need to be a viewer and everything else an editor
 * (`actor.access`, set from the operation). A project the actor has no access to is not found.
 */
export async function getProject(actor: Actor, projectId: string, need?: ProjectRole): Promise<Project> {
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
	const role = project ? await roleFor(actor, project) : null;
	if (!project || !role) throw notFound("Project");
	const required = need ?? (actor.access === "view" ? "viewer" : "editor");
	if (!atLeast(role, required)) {
		throw forbidden(
			required === "owner"
				? "Only the project's owner can do that."
				: "You can view this project but not change it. Ask its owner to make you an editor.",
			required === "owner" ? "owner_only" : "read_only",
		);
	}
	return project;
}

/** Projects the actor owns, then projects shared with them, each most recently updated first. */
export async function listProjects(actor: Actor) {
	const [owned, memberships] = await Promise.all([
		db.query.projects.findMany({ where: eq(schema.projects.ownerId, actor.id), orderBy: desc(schema.projects.updatedAt) }),
		db.query.projectMembers.findMany({ where: eq(schema.projectMembers.userId, actor.id) }),
	]);
	const shared = memberships.length
		? await db
				.select({ project: schema.projects, ownerName: schema.user.name, ownerEmail: schema.user.email })
				.from(schema.projects)
				.innerJoin(schema.user, eq(schema.user.id, schema.projects.ownerId))
				.where(inArray(schema.projects.id, memberships.map((member) => member.projectId)))
				.orderBy(desc(schema.projects.updatedAt))
		: [];
	const roles = new Map(memberships.map((member) => [member.projectId, member.role]));
	return Promise.all([
		...owned.map(async (project) => ({ ...(await projectSummary(project)), role: "owner" as ProjectRole })),
		...shared.map(async (row) => ({
			...(await projectSummary(row.project)),
			role: roles.get(row.project.id)! as ProjectRole,
			owner: { name: row.ownerName, email: row.ownerEmail },
		})),
	]);
}

export async function projectSummary(project: Project) {
	const [[videos], [assets]] = await Promise.all([
		db.select({ n: count() }).from(schema.videos).where(eq(schema.videos.projectId, project.id)),
		db
			.select({ n: count() })
			.from(schema.assets)
			.where(and(eq(schema.assets.projectId, project.id), eq(schema.assets.status, "ready"), notSceneMedia())),
	]);
	return {
		id: project.id,
		name: project.name,
		description: project.description,
		brandName: project.brand.identity?.name,
		videos: videos?.n ?? 0,
		assets: assets?.n ?? 0,
		createdAt: project.createdAt,
		updatedAt: project.updatedAt,
	};
}

/** How much of the brand kit is filled in, so an agent knows what to ask for. */
export function brandCompleteness(brand: BrandKit) {
	const sections = Object.keys(BrandKit.shape) as (keyof BrandKit)[];
	const filled = sections.filter((key) => {
		const value = brand[key];
		if (value === undefined || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		return Object.keys(value).length > 0;
	});
	return { filled, missing: sections.filter((key) => !filled.includes(key)) };
}
