variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>), and handed to the relay as RESOURCE_PREFIX."
  type        = string
}

variable "aws_region" {
  description = "Region the relay runs in — used to scope the SSM parameter ARNs in its IAM policy."
  type        = string
}

variable "reserved_concurrency" {
  description = "Ceiling on concurrent relay executions — a cost bound, not a capacity plan. -1 removes the ceiling."
  type        = number
  default     = 50
}

variable "binary_path" {
  description = "The linux/arm64 bootstrap binary build.sh produces."
  type        = string
}

variable "storage" {
  description = "The storage module's outputs — ARNs for the relay's IAM policy. Names aren't passed: the relay derives them from RESOURCE_PREFIX."
  type = object({
    table_arn              = string
    bucket_arn             = string
    invite_table_arn       = string
    sessions_table_arn     = string
    accounts_table_arn     = string
    accounts_old_table_arn = string
    circles_table_arn      = string
    rate_limit_table_arn   = string
    push_table_arn         = string
  })
}

variable "behind_cloudfront" {
  description = "Whether a CloudFront distribution fronts this function. True locks the function URL to signed requests from it; false leaves it publicly callable. Must not be true before the distribution exists."
  type        = bool
  default     = false
}

variable "settings" {
  description = "Tuning the relay reads from its environment — blob size cap, invite retention, rate limits. Terraform's rather than <env>.env's because they are decisions worth reviewing in a diff, and applying them needs no extra step."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "How long the relay's logs are kept. Long enough to investigate something reported late, short enough that nothing accumulates."
  type        = number
  default     = 30
}
