import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { BrandKit, mergeBrand } from "../../../shared/brand.ts";
import { db, schema } from "../db/client.ts";
import { NOTE_KINDS } from "../db/schema.ts";
import { badRequest, newId, notFound } from "../lib/util.ts";
import { deletePrefix } from "../services/storage.ts";
import { WORKFLOW_GUIDE, projectBrief } from "../services/brief.ts";
import { CRAFT, CRAFT_TOPICS, craftTopic } from "../services/craft.ts";
import { brandCompleteness, getProject, listProjects, projectSummary } from "../services/projects.ts";
import { describeControls } from "../../../shared/controls.ts";
import { getControls } from "../services/controls.ts";
import { budgetStatus } from "../services/usage.ts";
import { defineOp } from "./registry.ts";

const projectId = z.string().describe("Project id (prj_…)");

export const projectOps = [
	defineOp({
		name: "whoami",
		title: "Who am I",
		description:
			"The signed-in account, its role and billing status, this month's charges, credit and what is left of its spend cap, and what its cost controls switch off or limit. " +
			"billing.spend has the full breakdown.",
		input: z.object({}),
		readOnly: true,
		handler: async (_input, { actor }) => ({
			id: actor.id,
			email: actor.email,
			name: actor.name,
			role: actor.isAdmin ? "admin" : "user",
			billing: actor.billing,
			budget: await budgetStatus(actor),
			costControls: describeControls(await getControls(actor.id)),
		}),
	}),

	defineOp({
		name: "guide",
		title: "How to make a video",
		description:
			"The recommended order of operations for producing a video (read it once if you have not used Retween before), " +
			"or, with a topic, short notes on the craft: what makes an opening, pacing, structure, Shorts, thumbnails, publishing, originality at volume and working with a reviewer.",
		input: z.object({ topic: z.enum(CRAFT_TOPICS).optional().describe("A craft topic. Leave out for the workflow") }),
		readOnly: true,
		handler: async (input) => {
			if (!input.topic) return { guide: WORKFLOW_GUIDE, topics: CRAFT.map(({ topic, summary }) => ({ topic, summary })) };
			const item = craftTopic(input.topic)!;
			return { topic: item.topic, title: item.title, guide: item.body };
		},
	}),

	defineOp({
		name: "project.list",
		title: "List projects",
		description: "Your projects, most recently updated first. A project holds one brand's kit, assets and videos.",
		input: z.object({}),
		readOnly: true,
		handler: async (_input, { actor }) => ({ projects: await listProjects(actor) }),
	}),

	defineOp({
		name: "project.create",
		title: "Create project",
		description:
			"Create a project for a brand, product or channel. Optionally seed the brand kit; anything left out can be added later with brand.update.",
		input: z.object({
			name: z.string().min(1).max(120),
			description: z.string().max(2000).optional().describe("What this project is for"),
			brand: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("Initial brand kit, any subset. Same shape as brand.update's patch; see brand.schema for every field"),
		}),
		handler: async (input, { actor }) => {
			const brand = BrandKit.safeParse(input.brand ?? {});
			if (!brand.success) throw badRequest("That does not fit the brand kit", z.treeifyError(brand.error));
			const [project] = await db
				.insert(schema.projects)
				.values({ id: newId("prj"), ownerId: actor.id, name: input.name, description: input.description, brand: brand.data })
				.returning();
			return { project: await projectSummary(project!), brandKit: brandCompleteness(project!.brand) };
		},
	}),

	defineOp({
		name: "project.get",
		title: "Get project",
		description: "A project with its full brand kit. For a readable summary to work from, use project.brief instead.",
		input: z.object({ projectId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			return { project: { ...(await projectSummary(project)), brand: project.brand }, brandKit: brandCompleteness(project.brand) };
		},
	}),

	defineOp({
		name: "project.update",
		title: "Update project",
		description: "Rename a project or change its description.",
		input: z.object({ projectId, name: z.string().min(1).max(120).optional(), description: z.string().max(2000).optional() }),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const [updated] = await db
				.update(schema.projects)
				.set({ name: input.name ?? project.name, description: input.description ?? project.description })
				.where(eq(schema.projects.id, project.id))
				.returning();
			return { project: await projectSummary(updated!) };
		},
	}),

	defineOp({
		name: "project.delete",
		title: "Delete project",
		description: "Permanently delete a project with all of its assets, videos and renders. Cannot be undone.",
		input: z.object({ projectId, confirm: z.literal(true).describe("Must be true") }),
		destructive: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			// Everything a project stores lives under one prefix: assets, renders and preview frames.
			const files = await deletePrefix(`projects/${project.id}/`);
			await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
			return { deleted: project.id, files };
		},
	}),

	defineOp({
		name: "project.brief",
		title: "Project brief",
		description:
			"The production brief for a project: standing instructions, brand identity, audience, writing voice, narration voice, visual style, motion, format, cast, pinned notes and reusable assets, as one document. Read it before writing or changing a video in the project.",
		input: z.object({ projectId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const [brief, controls] = await Promise.all([projectBrief(await getProject(actor, input.projectId)), getControls(actor.id)]);
			const limits = describeControls(controls);
			// The account's cost controls decide what a storyboard can sensibly ask for, so they travel with the brief.
			return { brief: limits.length ? `${brief.trimEnd()}\n\n## Cost controls (this account)\n\n${limits.map((line) => `- ${line}`).join("\n")}\n` : brief };
		},
	}),

	defineOp({
		name: "brand.get",
		title: "Get brand kit",
		description: "The project's brand kit as structured data, and which sections are still empty.",
		input: z.object({ projectId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			return { brand: project.brand, ...brandCompleteness(project.brand) };
		},
	}),

	defineOp({
		name: "brand.update",
		title: "Update brand kit",
		description:
			"Change the brand kit. Send only what changes: objects are merged, lists and values are replaced, and null clears a field. " +
			"Sections: identity, audience, messaging (tone, do/don't say, hooks, CTAs, glossary), narration (voice, pace, pronunciations), " +
			"visual (palette, fonts, logo, image style lock and reference images), motion, captions, audio (music, sonic logo), " +
			"format (aspect ratios, pacing, watermark), cast (recurring people/products with reference images) and instructions (standing instructions).",
		input: z.object({
			projectId,
			patch: z
				.record(z.string(), z.unknown())
				.describe('Partial brand kit, e.g. {"visual":{"palette":{"accent":"#FF5500"}},"narration":{"speed":1.05}}'),
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const merged = BrandKit.safeParse(mergeBrand(project.brand, input.patch));
			if (!merged.success) throw badRequest("That change does not fit the brand kit", z.treeifyError(merged.error));
			await db.update(schema.projects).set({ brand: merged.data }).where(eq(schema.projects.id, project.id));
			return { brand: merged.data, ...brandCompleteness(merged.data) };
		},
	}),

	defineOp({
		name: "brand.schema",
		title: "Brand kit schema",
		description: "The full JSON Schema of the brand kit, listing every field that can be set with brand.update and what it does.",
		input: z.object({}),
		readOnly: true,
		handler: async () => ({ schema: z.toJSONSchema(BrandKit, { io: "input" }) }),
	}),

	defineOp({
		name: "note.list",
		title: "List notes",
		description: "Notes kept in a project: guidelines, learnings from past videos, reference material, scripts and ideas.",
		input: z.object({ projectId, kind: z.enum(NOTE_KINDS).optional() }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const notes = await db.query.notes.findMany({
				where: and(eq(schema.notes.projectId, project.id), input.kind ? eq(schema.notes.kind, input.kind) : undefined),
				orderBy: desc(schema.notes.updatedAt),
			});
			return { notes };
		},
	}),

	defineOp({
		name: "note.save",
		title: "Save note",
		description:
			"Create a note, or update one by passing its noteId. Use notes for anything worth remembering that does not fit the brand kit: " +
			"feedback on a finished video (kind learning), house rules (guideline), source material (reference), reusable script passages (script), ideas for later (idea). " +
			"Pinned notes are included in the project brief.",
		input: z.object({
			projectId,
			noteId: z.string().optional().describe("Update this note instead of creating one"),
			kind: z.enum(NOTE_KINDS).default("guideline"),
			title: z.string().min(1).max(200),
			body: z.string().min(1).max(20000),
			pinned: z.boolean().default(true).describe("Include in the project brief"),
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const values = { kind: input.kind, title: input.title, body: input.body, pinned: input.pinned };
			if (input.noteId) {
				const [note] = await db
					.update(schema.notes)
					.set(values)
					.where(and(eq(schema.notes.id, input.noteId), eq(schema.notes.projectId, project.id)))
					.returning();
				if (!note) throw notFound("Note");
				return { note };
			}
			const [note] = await db
				.insert(schema.notes)
				.values({ id: newId("nte"), projectId: project.id, ...values })
				.returning();
			return { note };
		},
	}),

	defineOp({
		name: "note.delete",
		title: "Delete note",
		description: "Delete a note.",
		input: z.object({ projectId, noteId: z.string() }),
		destructive: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const deleted = await db
				.delete(schema.notes)
				.where(and(eq(schema.notes.id, input.noteId), eq(schema.notes.projectId, project.id)))
				.returning({ id: schema.notes.id });
			if (!deleted.length) throw notFound("Note");
			return { deleted: input.noteId };
		},
	}),
];
