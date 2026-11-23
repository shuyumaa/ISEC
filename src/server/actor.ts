import { AsyncLocalStorage } from "node:async_hooks";

/*
 * Who is making the current request, for the activity log. The middleware
 * runs every request inside `runAs`, so mutations can log the real account
 * ("admin", "team:northwind-coach") without passing it around.
 */
const store = new AsyncLocalStorage<{ actor: string }>();

export const runAs = <T>(actor: string, fn: () => T): T => store.run({ actor }, fn);
export const actor = () => store.getStore()?.actor ?? "system";
