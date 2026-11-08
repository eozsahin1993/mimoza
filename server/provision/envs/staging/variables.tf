variable "aws_profile" {
  description = "Local AWS profile to apply with. Empty uses the ambient credentials — which is what CI does, assuming its role via OIDC."
  type        = string
  default     = ""
}

variable "aws_account_id" {
  description = "The account this env belongs to. Set it and Terraform refuses to apply anywhere else. Kept out of git: a gitignored *.auto.tfvars locally, a GitHub Environment variable in CI."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Where alarms mail — billing, and the relay's own throttles, errors and latency. Empty creates none of them, which for billing matters: AWS has no spending cap."
  type        = string
  default     = ""
}

variable "env_domain" {
  description = "This environment's zone — staging.example.com, or example.com for production. api.<zone> and cdn.<zone> are derived from it, under one wildcard certificate. Empty leaves the raw function URL and presigned S3 URLs."
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "owner/repo whose Actions may deploy this env, as the GitHub OIDC trust policy's subject. Empty creates no deploy role."
  type        = string
  default     = ""
}

variable "github_owner_id" {
  description = "Numeric GitHub id of github_repository's owner. CI passes github.repository_owner_id; `gh api repos/<owner>/<repo> --jq .owner.id` locally."
  type        = string
  default     = ""
}

variable "github_repository_id" {
  description = "Numeric GitHub id of github_repository. CI passes github.repository_id; `gh api repos/<owner>/<repo> --jq .id` locally."
  type        = string
  default     = ""
}
