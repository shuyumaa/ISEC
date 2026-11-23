import type { APIRoute } from "astro";
import { destroySession } from "../server/auth";

/** Sign out of either panel (POST only, so a link or prefetch can't do it). */
export const POST: APIRoute = ({ cookies, redirect }) => {
  destroySession(cookies);
  return redirect("/login/", 303);
};
