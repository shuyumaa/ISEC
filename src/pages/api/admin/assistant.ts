import type { APIRoute } from "astro";
import { createAgentUIStreamResponse, type InferAgentUIMessage, type UIMessage } from "ai";
import { adminAgent } from "../../../server/ai/agent";
import { isChatId, saveChat } from "../../../server/ai/chats";
import { FormError } from "../../../server/forms";

/*
 * Streams the admin assistant's reply (AI SDK UI message stream). Admin-only
 * (middleware: /api/admin/*), same-origin only, body capped in middleware.
 * The client sends the conversation each turn; it is saved to the admin's
 * chat history (server/ai/chats.ts) before and after the answer.
 */

type AgentMessage = InferAgentUIMessage<ReturnType<typeof adminAgent>>;

const MAX_MESSAGES = 60;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (user?.role !== "admin") return new Response("Unauthorized", { status: 401 });
  let messages: UIMessage[];
  let chatId: string | undefined;
  try {
    const body = (await request.json()) as { id?: unknown; messages?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("no messages");
    messages = body.messages.slice(-MAX_MESSAGES) as UIMessage[];
    chatId = isChatId(body.id) ? body.id : undefined;
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
  // Save the question straight away, so it's kept even if the answer fails.
  const persist = (all: UIMessage[]) => {
    if (!chatId) return;
    try {
      saveChat(chatId, user.username, all);
    } catch (e) {
      console.error("[isec] couldn't save chat", e);
    }
  };
  persist(messages);
  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal: request.signal,
    originalMessages: messages as AgentMessage[],
    // Runs when the answer ends, also when it was stopped half-way.
    onEnd: ({ messages: all }) => persist(all),
    onError: (e) => {
      console.error("[isec] assistant error", e);
      // Provider errors are shown to the admin (no secrets in them); anything else stays generic.
      const m = e instanceof Error ? e.message : "";
      return /api key|unauthori[sz]ed|401|403|quota|rate limit|model/i.test(m) ? `The AI provider said: ${m.slice(0, 200)}` : "Something went wrong while answering. Try again.";
    },
  });
};
