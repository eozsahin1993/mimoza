/**
 * Cloudflare Pages Function — deployed automatically alongside the static
 * build for anything under functions/, with no separate service to run.
 * This is the only place RESEND_API_KEY is used; the browser never sees
 * it. Needs two secrets set in the Pages project (Settings > Environment
 * variables): RESEND_API_KEY and RESEND_AUDIENCE_ID (create an Audience
 * in the Resend dashboard first and copy its id).
 *
 * If the site ends up on a different host than Cloudflare Pages, this
 * file's shape (a default export taking a Fetch API Request and
 * returning a Response) also works unchanged as a Vercel or Netlify edge
 * function — only where it lives and how its env vars are set would
 * change.
 */

interface Env {
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
}

// Deliberately just {request, env}, not the @cloudflare/workers-types
// PagesFunction type — this file needs no new dependency, and the same
// shape is what Vercel/Netlify's edge functions expect too.
type Context = { request: Request; env: Env };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) {
    return json({ error: "Waitlist isn't configured yet." }, 500);
  }

  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "That doesn't look like an email address." }, 400);
  }

  const resendResponse = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  });

  // Resend returns 409 for an email already on the list — that's success
  // from this form's point of view, not an error to surface.
  if (!resendResponse.ok && resendResponse.status !== 409) {
    return json({ error: "Could not add you to the list." }, 502);
  }

  return json({ ok: true });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
