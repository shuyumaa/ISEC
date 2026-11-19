import type { APIRoute } from "astro";
import { subscribe } from "../../server/bus";
import { currentVersion } from "../../server/db";

/*
 * Server-Sent Events stream of data changes. Every admin write is broadcast as
 *   event: change   id: <version>   data: {"version":n,"changes":[{kind,id,op}]}
 * Pages subscribe and re-render only the regions that depend on what changed.
 */
export const GET: APIRoute = ({ request }) => {
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
