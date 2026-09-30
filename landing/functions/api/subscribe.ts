/**
 * Cloudflare Pages Function — deployed automatically alongside the static
 * build for anything under functions/, with no separate service to run.
 * This is the only place RESEND_API_KEY is used; the browser never sees
 * it. Needs RESEND_API_KEY set as a Pages secret (an API key with Full
 * access — a Sending-access key can't create contacts). RESEND_SEGMENT_ID
 * is optional: Resend has no separate "Audience" to create first, a
 * contact just belongs to the account, and a Segment is only an
 * organizational tag for later — set it if you want the waitlist tagged,
 * leave it unset otherwise.
 *
 * If the site ends up on a different host than Cloudflare Pages, this
 * file's shape (a function taking a Fetch API Request and returning a
 * Response) also works unchanged as a Vercel or Netlify edge function —
 * only where it lives and how its env vars are set would change.
 */

interface Env {
  RESEND_API_KEY: string;
  RESEND_SEGMENT_ID?: string;
}

// Deliberately just {request, env}, not the @cloudflare/workers-types
// PagesFunction type — this file needs no new dependency, and the same
// shape is what Vercel/Netlify's edge functions expect too.
type Context = { request: Request; env: Env };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.RESEND_API_KEY) {
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

  const resendResponse = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      unsubscribed: false,
      ...(env.RESEND_SEGMENT_ID ? { segments: [env.RESEND_SEGMENT_ID] } : {}),
    }),
  });

  // Resend's docs don't document what a duplicate email returns; treating
  // a conflict-shaped response as success rather than an error, since
  // "you're already on the list" isn't a failure from this form's side.
  if (!resendResponse.ok && resendResponse.status !== 409 && resendResponse.status !== 422) {
    return json({ error: "Could not add you to the list." }, 502);
  }

  return json({ ok: true });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
