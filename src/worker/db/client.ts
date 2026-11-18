import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { isTransient, withRetry } from "../lib/util.ts";
import * as schema from "./schema.ts";

/** Reads are safe to repeat; writes are not retried here, because a write that timed out may have happened. */
const isRead = (sql: string) => /^\s*(select|with|pragma)\b/i.test(sql);

/**
 * D1 occasionally drops a query ("Network connection lost", "D1 DB is
 * overloaded", an object reset). Cloudflare's advice is to retry, so every
 * read statement gets a couple more tries before the error surfaces.
 */
const originals = new WeakMap<object, D1PreparedStatement>();

function retryingStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
	if (!isRead(sql)) return statement;
	const proxy = new Proxy(statement, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			if (property === "bind") return (...args: unknown[]) => retryingStatement(value.apply(target, args), sql);
			if (property === "all" || property === "raw" || property === "first" || property === "run") {
				return (...args: unknown[]) => withRetry(() => value.apply(target, args), { attempts: 3, baseDelayMs: 150, retryIf: isTransient });
			}
			return value.bind(target);
		},
	});
	originals.set(proxy, statement);
	return proxy;
}

const database = new Proxy(env.DB, {
	get(target, property) {
		const value = Reflect.get(target, property);
		if (property === "prepare") return (sql: string) => retryingStatement(target.prepare(sql), sql);
		// The native batch only accepts its own statement objects.
		if (property === "batch") return (statements: D1PreparedStatement[]) => target.batch(statements.map((statement) => originals.get(statement) ?? statement));
		return typeof value === "function" ? value.bind(target) : value;
	},
});

export const db = drizzle(database, { schema });
export { schema };
