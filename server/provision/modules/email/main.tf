# What the relay emails feedback with: the sending domain and, because the
# account stays in SES's sandbox on purpose (both ends of every send are
# ours, so production access would only widen what a compromised relay
# could do), the one inbox it sends to. Every environment is its own
# account, so each verifies the same domain again with its own DKIM keys
# — the records differ per account and sit side by side at the DNS
# provider.
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity" "inbox" {
  email_identity = var.inbox
}

# The website's support form runs as a Cloudflare Pages Function, which
# has no IAM role to send as, so it signs each request with this user's
# key. The policy is the relay's own, narrowed to this one identity;
# the key itself is minted by hand (`aws iam create-access-key`) and set
# as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on the Pages project.
resource "aws_iam_user" "website_sender" {
  count = var.website_sender ? 1 : 0
  name  = "website-mailer"
}

data "aws_iam_policy_document" "website_sender" {
  count = var.website_sender ? 1 : 0

  statement {
    sid       = "SendAsSupportDomain"
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.domain.arn]
  }
}

resource "aws_iam_user_policy" "website_sender" {
  count  = var.website_sender ? 1 : 0
  name   = "send-as-support-domain"
  user   = aws_iam_user.website_sender[0].name
  policy = data.aws_iam_policy_document.website_sender[0].json
}
