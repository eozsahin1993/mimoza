/**
 * The support form on /support. Needs AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY set as Pages secrets: the key of the IAM user
 * server/provision/modules/email creates in the production account,
 * allowed to send as joinmimoza.com and nothing else. The recipient is
 * the public support address, which Cloudflare routes onward, so no
 * private address appears here and SES's sandbox is satisfied, since
 * both ends are verified.
 */

import { sendEmail, type EmailEnv } from "../../shared/send-email";

type Env = EmailEnv;

type Context = { request: Request; env: Env };

const FROM_ADDRESS = "support@joinmimoza.com";
const TO_ADDRESS = "hello@joinmimoza.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LENGTH = 4000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
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
      to: TO_ADDRESS,
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
