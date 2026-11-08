variable "name_prefix" {
  description = "Prefix applied to every named resource (mimoza-<env>)."
  type        = string
}

variable "repository" {
  description = "owner/repo allowed to assume the role. Anything else presenting a GitHub token is refused."
  type        = string
}

variable "owner_id" {
  description = "Numeric id of the repository's owner, as GitHub puts it in the token subject."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.owner_id))
    error_message = "owner_id must be the owner's numeric GitHub id."
  }
}

variable "repository_id" {
  description = "Numeric id of the repository, as GitHub puts it in the token subject."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.repository_id))
    error_message = "repository_id must be the repository's numeric GitHub id."
  }
}

variable "environment" {
  description = "The GitHub Environment a workflow must declare to assume this role — the gate that carries the approval rules."
  type        = string
}
