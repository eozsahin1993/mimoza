/**
 * The support form on /support. Needs CF_EMAIL_API_TOKEN,
 * CF_EMAIL_ACCOUNT_ID and CONTACT_TO_ADDRESS set as Pages secrets, and
 * support@joinmimoza.com verified as a sending address in Cloudflare
 * Email Service first. CONTACT_TO_ADDRESS is deliberately a secret
 * rather than a literal here — the owner's own address never appears in
 * the repo.
 */

import { sendEmail, type EmailEnv } from "../../shared/send-email";

interface Env extends EmailEnv {
  CONTACT_TO_ADDRESS: string;
}

type Context = { request: Request; env: Env };

const FROM_ADDRESS = "support@joinmimoza.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LENGTH = 4000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.CF_EMAIL_API_TOKEN || !env.CF_EMAIL_ACCOUNT_ID || !env.CONTACT_TO_ADDRESS) {
    return json({ error: "Contact form isn't configured yet." }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const { email, message } = (body ?? {}) as { email?: unknown; message?: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "That doesn't look like an email address." }, 400);
  }
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    return json({ error: `Message must be 1-${MAX_MESSAGE_LENGTH} characters.` }, 400);
  }

  try {
    await sendEmail(env, {
      to: env.CONTACT_TO_ADDRESS,
      from: FROM_ADDRESS,
      replyTo: email,
      subject: `Mimoza support: ${email}`,
      text: message,
      html: `<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
    });
  } catch {
    return json({ error: "Could not send your message." }, 502);
  }

  return json({ ok: true });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
