import type { APIRoute } from "astro";
import { subscribe } from "../../server/bus";
import { currentVersion } from "../../server/db";

/*
 * Server-Sent Events stream of data changes. Every admin write is broadcast as
 *   event: change   id: <version>   data: {"version":n,"changes":[{kind,id,op}]}
 * Pages subscribe and re-render only the regions that depend on what changed.
 */
const MAX_TOTAL = 5000;
// Generous: a whole school can sit behind one NAT address.
const MAX_PER_IP = 64;
const perIp = new Map<string, number>();
let total = 0;

export const GET: APIRoute = ({ request, clientAddress }) => {
  const ip = clientAddress ?? "unknown";
  if (total >= MAX_TOTAL || (perIp.get(ip) ?? 0) >= MAX_PER_IP) {
    return new Response("Too many live connections", { status: 429, headers: { "Retry-After": "30" } });
  }
  total += 1;
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    total -= 1;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      // Tell clients how long to wait before reconnecting, and the current version
      // so a reconnecting client can tell whether it missed anything.
      send(`retry: 3000\nevent: hello\nid: ${currentVersion()}\ndata: ${JSON.stringify({ version: currentVersion() })}\n\n`);

      const unsubscribe = subscribe((set) => {
        send(`event: change\nid: ${set.version}\ndata: ${JSON.stringify(set)}\n\n`);
      });
      // Comment lines keep proxies from closing idle connections.
      const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), 20_000);

      cleanup = () => {
        release();
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
