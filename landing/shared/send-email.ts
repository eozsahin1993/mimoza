/**
 * Cloudflare Email Service's REST API, wrapped once for every Pages
 * Function that needs to send mail. Lives outside functions/ on purpose:
 * that directory is routed by file path, and a helper with no
 * onRequest* export doesn't fit that shape — Cloudflare's own docs don't
 * define what happens to a non-handler file there, so this just stays
 * out of it.
 *
 * Addresses, subject and body are the caller's concern; this only knows
 * how to authenticate and call the API.
 */

export interface EmailEnv {
  CF_EMAIL_API_TOKEN: string;
  CF_EMAIL_ACCOUNT_ID: string;
}

export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(env: EmailEnv, message: EmailMessage): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_EMAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: message.to,
      from: message.from,
      // Dedicated fields, not the generic `headers` map — Reply-To there
      // is rejected with E_HEADER_NOT_ALLOWED; this is the one Cloudflare
      // wants it set through instead.
      reply_to: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare Email Service responded ${response.status}`);
  }
}
