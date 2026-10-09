variable "domain" {
  description = "The domain the relay sends as (see server/internal/feedback). Verified by DKIM: the records come back as an output to add at the DNS provider."
  type        = string
}

variable "inbox" {
  description = "The address the relay sends to. Verified too, because the account stays in SES's sandbox, where every recipient must be. SES mails this address a confirmation link on apply."
  type        = string
}
