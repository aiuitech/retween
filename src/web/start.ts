import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/** Server functions act as the signed-in person, so they only answer requests that come from this site's own pages. */
export const startInstance = createStart(() => ({
	requestMiddleware: [createCsrfMiddleware()],
}));
