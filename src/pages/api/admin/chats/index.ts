import type { APIRoute } from "astro";
import { listChats } from "../../../../server/ai/chats";

/** The signed-in admin's saved assistant chats, newest first. */
export const GET: APIRoute = ({ locals }) => {
  const user = locals.user;
  if (user?.role !== "admin") return new Response("Unauthorized", { status: 401 });
  return Response.json(listChats(user.username), { headers: { "Cache-Control": "no-store" } });
};
