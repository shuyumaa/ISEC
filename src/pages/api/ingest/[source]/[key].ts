import type { APIRoute } from "astro";
import { ingest } from "../../../../server/ingest";

/*
 * Game-server ingest.
 *   POST /api/ingest/cs2/<key>   body: CS2 log lines (logaddress_add_http)
 *   POST /api/ingest/gsi/<key>   body: CS2 Game State Integration JSON
 * The unguessable key in the path is the credential (CS2 can't send headers).
 */
const MAX_BYTES = 1_000_000;

export const POST: APIRoute = async ({ params, request }) => {
  const source = params.source === "cs2" ? "cs2-log" : params.source === "gsi" ? "gsi" : undefined;
  if (!source || !params.key) return new Response("Not found", { status: 404 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return new Response("Payload too large", { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BYTES) return new Response("Payload too large", { status: 413 });

  try {
    const result = ingest(params.key, source, body);
    if (!result.ok) return new Response(result.error, { status: result.status });
    return new Response(null, { status: 204 });
  } catch (e) {
    console.error("[isec] ingest failed", e);
    return new Response("Ingest error", { status: 500 });
  }
};

export const ALL: APIRoute = () => new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
