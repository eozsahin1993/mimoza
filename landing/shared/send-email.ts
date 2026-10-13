/**
 * Amazon SES, wrapped once for every Pages Function that needs to send
 * mail. Lives outside functions/ on purpose: that directory is routed by
 * file path, and a helper with no onRequest* export doesn't fit that
 * shape — Cloudflare's own docs don't define what happens to a
 * non-handler file there, so this just stays out of it.
 *
 * SES rather than Cloudflare's own Email Service because sending through
 * that needs the paid Workers plan, and the relay already sends feedback
 * through SES as the same domain. A Pages Function has no IAM role, so
 * it signs each request itself with an access key for a user allowed to
 * do exactly this — see server/provision/modules/email.
 *
 * Addresses, subject and body are the caller's concern; this only knows
 * how to authenticate and call the API.
 */

import { AwsClient } from "aws4fetch";

export interface EmailEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  /** Where the SES identity lives. Defaults to us-east-1, same as the relay. */
  AWS_REGION?: string;
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
  const region = env.AWS_REGION || "us-east-1";
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "ses",
    region,
  });

  const response = await aws.fetch(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [message.to] },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`SES responded ${response.status}`);
  }
}
