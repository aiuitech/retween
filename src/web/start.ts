import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * Server functions act as the signed-in person, so they only answer requests that come from this site's own pages.
 * Only server function calls are checked: page loads arrive from links, bookmarks and typed URLs, which are cross-site
 * or carry no origin at all, and must still be served.
 */
export const startInstance = createStart(() => ({
	requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })],
}));
