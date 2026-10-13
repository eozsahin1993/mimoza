variable "domain" {
  description = "The domain the relay sends as (see server/internal/feedback). Verified by DKIM: the records come back as an output to add at the DNS provider."
  type        = string
}

variable "inbox" {
  description = "The address the relay sends to. Verified too, because the account stays in SES's sandbox, where every recipient must be. SES mails this address a confirmation link on apply."
  type        = string
}

variable "website_sender" {
  description = "Also create an IAM user the website's support form signs SES requests with (landing/shared/send-email.ts). Its access key is created by hand and set as a Pages secret, so the secret never enters state. Production only: the website is one site."
  type        = bool
  default     = false
}
