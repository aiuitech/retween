import { eq } from "drizzle-orm";
import { z } from "zod";
import { CLIP_RESOLUTIONS, CostControls, IMAGE_QUALITIES, VOICE_MODELS, describeControls } from "../../../shared/controls.ts";
import { RESOLUTIONS } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { forbidden, notFound } from "../lib/util.ts";
import { getControls, updateControls } from "../services/controls.ts";
import { defineOp } from "./registry.ts";

/** Whose controls: your own, or (administrators only) another account's. */
async function targetUser(actor: { id: string; isAdmin: boolean }, userId?: string): Promise<string> {
	if (!userId || userId === actor.id) return actor.id;
	if (!actor.isAdmin) throw forbidden("Only administrators can change another account's cost controls");
	const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
	if (!user) throw notFound("User");
	return user.id;
}

export const accountOps = [
	defineOp({
		name: "account.controls",
		title: "Cost controls",
		description:
			"What this account lets Retween spend money on: which kinds of media may be generated (clips, images, vectors, cut-outs, music, sound effects), " +
			"limits on clip resolution and length, image quality and export resolution, the narration voice model, and an optional own monthly spending limit. " +
			"Read this before planning a storyboard: media that is switched off is replaced by a cheaper stand-in when preparing, and refused when asked for directly.",
		readOnly: true,
		input: z.object({ userId: z.string().optional().describe("Administrators only: another account") }),
		handler: async (input, { actor }) => {
			const controls = await getControls(await targetUser(actor, input.userId));
			return {
				controls,
				summary: describeControls(controls),
				options: { voiceModels: VOICE_MODELS, imageQualities: IMAGE_QUALITIES, clipResolutions: CLIP_RESOLUTIONS, renderResolutions: RESOLUTIONS },
			};
		},
	}),

	defineOp({
		name: "account.controls_update",
		title: "Update cost controls",
		description:
			"Change the account's cost controls. Pass only the fields to change. They affect new spending only: media already generated keeps being used, " +
			"and nothing is regenerated because a control changed. Only change these when the person asks to.",
		input: CostControls.partial().extend({ userId: z.string().optional().describe("Administrators only: another account") }),
		handler: async ({ userId, ...change }, { actor }) => {
			const controls = await updateControls(await targetUser(actor, userId), change);
			return { controls, summary: describeControls(controls) };
		},
	}),
];
