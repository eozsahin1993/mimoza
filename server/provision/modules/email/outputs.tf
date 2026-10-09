output "identity_arn" {
  description = "The domain identity, for the relay's IAM policy."
  value       = aws_sesv2_email_identity.domain.arn
}

# The DNS side is manual, same as the certificate's validation record.
output "dkim_records" {
  description = "Three CNAMEs to add at the DNS provider, unproxied. SES marks the domain verified once they resolve; the inbox is verified by the link SES mails it."
  value = [
    for token in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      name  = "${token}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
}
