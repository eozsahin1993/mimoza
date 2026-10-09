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
