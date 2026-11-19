import { EventEmitter } from "node:events";
import type { Change } from "./db";

/**
 * In-process change bus feeding the Server-Sent Events stream.
 * One Node process = one bus. To run several instances behind a load
 * balancer, replace this with Redis pub/sub or Postgres LISTEN/NOTIFY.
 */
export interface ChangeSet {
  version: number;
  changes: Change[];
}

const g = globalThis as typeof globalThis & { __isecBus?: EventEmitter };
const bus = (g.__isecBus ??= new EventEmitter().setMaxListeners(0));

export function publish(set: ChangeSet) {
  bus.emit("change", set);
}

export function subscribe(fn: (set: ChangeSet) => void): () => void {
  bus.on("change", fn);
  return () => bus.off("change", fn);
}

export const listenerCount = () => bus.listenerCount("change");
