import { and, count, desc, eq } from "drizzle-orm";
import { BrandKit } from "../../../shared/brand.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { notFound } from "../lib/util.ts";

export type Project = typeof schema.projects.$inferSelect;

/** The project, if the actor owns it (admins can open any project). */
export async function getProject(actor: Actor, projectId: string): Promise<Project> {
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
	if (!project || (project.ownerId !== actor.id && !actor.isAdmin)) throw notFound("Project");
	return project;
}

export async function listProjects(actor: Actor) {
	const rows = await db.query.projects.findMany({
		where: eq(schema.projects.ownerId, actor.id),
		orderBy: desc(schema.projects.updatedAt),
	});
	return Promise.all(rows.map(projectSummary));
}

export async function projectSummary(project: Project) {
	const [[videos], [assets]] = await Promise.all([
		db.select({ n: count() }).from(schema.videos).where(eq(schema.videos.projectId, project.id)),
		db
			.select({ n: count() })
			.from(schema.assets)
			.where(and(eq(schema.assets.projectId, project.id), eq(schema.assets.status, "ready"))),
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
