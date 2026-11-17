/**
 * The render container: a Durable Object fronting a container that runs
 * Remotion and headless Chrome. One instance is started per render (named by
 * the render id), and one per user is kept warm for preview frames (named
 * `preview-<user id>`). The names are how a run's cost finds its owner.
 */
import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { recordContainerRun } from "./services/metering.ts";

const RUN_STARTED = "runStartedAt";

export class Renderer extends Container<Env> {
	defaultPort = 8080;
	/** Stop paying for the instance soon after it goes quiet. Active renders are polled, which keeps it awake. */
	sleepAfter = "5m";
	enableInternet = true;
	/**
	 * Tags the container's usage in Cloudflare's analytics with the instance name, so the
	 * nightly reconciliation can replace a run's metered cost with the billed one.
	 */
	override labels: Record<string, string> = this.ctx.id.name ? { instance: this.ctx.id.name } : {};

	/**
	 * Cloudflare bills a container for as long as it runs, including the idle
	 * time before `sleepAfter` stops it, so the run is metered from start to stop
	 * and charged to whoever the instance belongs to (see `recordContainerRun`).
	 */
	override async onStart() {
		const stale = await this.ctx.storage.get<number>(RUN_STARTED);
		if (stale) console.warn("container run started without the previous one being metered", this.ctx.id.name, new Date(stale).toISOString());
		await this.ctx.storage.put(RUN_STARTED, Date.now());
	}

	override async onStop() {
		const startedAt = await this.ctx.storage.get<number>(RUN_STARTED);
		if (!startedAt) return;
		await this.ctx.storage.delete(RUN_STARTED);
		const instance = this.ctx.id.name;
		if (!instance) return console.warn("container run not metered: instance has no name");
		await recordContainerRun(instance, startedAt, Date.now()).catch((error) =>
			console.error("could not meter container run", instance, error instanceof Error ? error.message : error),
		);
	}
}

// The generated binding type does not recognise the Container base class as a Durable Object
// (the two packages brand their types separately), so the namespace is narrowed by hand.
const namespace = () => env.RENDERER as unknown as DurableObjectNamespace<Renderer>;

/** Calls the renderer's HTTP API on a named instance, starting it if needed. */
export async function rendererFetch(instance: string, path: string, init?: RequestInit): Promise<Response> {
	// Local development can point at a renderer running outside Docker.
	const local = import.meta.env.DEV ? (env as { DEV_RENDERER_URL?: string }).DEV_RENDERER_URL : undefined;
	if (local) return fetch(`${local}${path}`, init);
	return getContainer(namespace(), instance).fetch(new Request(`http://renderer${path}`, init));
}

/** Stops an instance without waiting for its idle timeout. */
export async function stopRenderer(instance: string): Promise<void> {
	if (import.meta.env.DEV && (env as { DEV_RENDERER_URL?: string }).DEV_RENDERER_URL) return;
	try {
		await getContainer(namespace(), instance).stop();
	} catch (error) {
		console.warn("could not stop renderer", instance, error instanceof Error ? error.message : error);
	}
}
