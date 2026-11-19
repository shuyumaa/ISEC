import type { APIRoute } from "astro";
import { destroySession } from "../../server/auth";

export const POST: APIRoute = ({ cookies, url, redirect }) => {
  destroySession(cookies, url);
  return redirect("/admin/login", 303);
};
