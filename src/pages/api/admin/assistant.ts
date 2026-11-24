import type { APIRoute } from "astro";
import { createAgentUIStreamResponse, type UIMessage } from "ai";
import { adminAgent } from "../../../server/ai/agent";
import { FormError } from "../../../server/forms";

/*
 * Streams the admin assistant's reply (AI SDK UI message stream). Admin-only
 * (middleware: /api/admin/*), same-origin only, body capped in middleware.
 * The client sends the whole conversation each turn; nothing is stored here.
 */

const MAX_MESSAGES = 60;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (user?.role !== "admin") return new Response("Unauthorized", { status: 401 });
  let messages: UIMessage[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("no messages");
    messages = body.messages.slice(-MAX_MESSAGES) as UIMessage[];
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  let agent;
  try {
    agent = adminAgent(user.username);
  } catch (e) {
    const msg = e instanceof FormError ? e.message : "The AI provider isn't set up correctly.";
    return Response.json({ error: msg }, { status: 409 });
  }
  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal: request.signal,
    onError: (e) => {
      console.error("[isec] assistant error", e);
      // Provider errors are shown to the admin (no secrets in them); anything else stays generic.
      const m = e instanceof Error ? e.message : "";
      return /api key|unauthori[sz]ed|401|403|quota|rate limit|model/i.test(m) ? `The AI provider said: ${m.slice(0, 200)}` : "Something went wrong while answering. Try again.";
    },
  });
};
