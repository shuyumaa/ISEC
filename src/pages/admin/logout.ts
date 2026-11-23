import type { APIRoute } from "astro";
import { destroySession } from "../../server/auth";

/** Old sign-out address, kept so existing forms keep working. */
export const POST: APIRoute = ({ cookies, redirect }) => {
  destroySession(cookies);
  return redirect("/login/", 303);
};
