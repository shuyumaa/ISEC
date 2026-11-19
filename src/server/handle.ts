import { FormError } from "./forms";

/**
 * Shared POST handling for admin forms.
 *  - Plain form submit (no JS): Post/Redirect/Get with ?saved=<message>.
 *  - Enhanced submit (fetch with X-ISEC-Enhanced): JSON { ok, message | error }.
 * Validation errors come back as { error, field } so the page can show them.
 */
export type Outcome = { redirect?: string; message?: string };

export async function handlePost(
  request: Request,
  fn: (form: FormData, intent: string) => Outcome | void | Promise<Outcome | void>,
): Promise<Response | { error: string; field?: string } | undefined> {
  if (request.method !== "POST") return undefined;
  const enhanced = request.headers.get("x-isec-enhanced") === "1";
  const form = await request.formData();
  // A clicked submit button can override the hidden default intent; it comes last.
  const intent = String(form.getAll("intent").at(-1) ?? "");
  try {
    const out = (await fn(form, intent)) ?? {};
    const message = out.message ?? "Saved";
    if (enhanced) return Response.json({ ok: true, message, redirect: out.redirect });
    const target = new URL(out.redirect ?? request.url, request.url);
    target.searchParams.set("saved", message);
    return new Response(null, { status: 303, headers: { Location: target.pathname + target.search } });
  } catch (e) {
    if (!(e instanceof FormError)) {
      console.error("[isec] admin action failed", e);
    }
    const error = e instanceof FormError ? e.message : "Something went wrong. Nothing was saved.";
    const field = e instanceof FormError ? e.field : undefined;
    if (enhanced) return Response.json({ ok: false, error, field }, { status: e instanceof FormError ? 422 : 500 });
    return { error, field };
  }
}
