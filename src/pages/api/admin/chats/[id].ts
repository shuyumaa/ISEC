import type { APIRoute } from "astro";
import { deleteChat, getChat, renameChat } from "../../../../server/ai/chats";
import { FormError } from "../../../../server/forms";

/* One saved chat: open it, rename it or delete it (owner only). */

const owner = (locals: App.Locals) => (locals.user?.role === "admin" ? locals.user.username : undefined);
const fail = (e: unknown) => Response.json({ error: e instanceof FormError ? e.message : "Something went wrong." }, { status: e instanceof FormError ? 404 : 500 });

export const GET: APIRoute = ({ params, locals }) => {
  const me = owner(locals);
  if (!me) return new Response("Unauthorized", { status: 401 });
  const c = getChat(params.id ?? "", me);
  return c ? Response.json(c, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Not found" }, { status: 404 });
};

export const PATCH: APIRoute = async ({ params, locals, request }) => {
  const me = owner(locals);
  if (!me) return new Response("Unauthorized", { status: 401 });
  try {
    const { title } = (await request.json()) as { title?: unknown };
    renameChat(params.id ?? "", me, String(title ?? ""));
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
};

export const DELETE: APIRoute = ({ params, locals }) => {
  const me = owner(locals);
  if (!me) return new Response("Unauthorized", { status: 401 });
  try {
    deleteChat(params.id ?? "", me);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
};
