/**
 * The render container: a Durable Object fronting a container that runs
 * Remotion and headless Chrome. One instance is started per render (named by
 * the render id), and one per user is kept warm for preview frames.
 */
import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class Renderer extends Container<Env> {
	defaultPort = 8080;
	/** Stop paying for the instance soon after it goes quiet. Active renders are polled, which keeps it awake. */
	sleepAfter = "5m";
	enableInternet = true;
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
