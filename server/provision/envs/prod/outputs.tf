output "api_endpoint" {
  description = "Base URL for this env's app builds (EXPO_PUBLIC_RELAY_URL)."
  value       = coalesce(module.cdn.api_endpoint, module.lambda.api_endpoint)
}

output "dns_records" {
  description = "Everything to add at the DNS provider, unproxied: the certificate's validation record, then a CNAME per hostname."
  value = {
    certificate_validation = one(module.certificate[*].validation_records)
    cnames                 = module.cdn.dns_records
    feedback_email_dkim    = module.email.dkim_records
  }
}

output "resource_prefix" {
  description = "RESOURCE_PREFIX, for running cmd/server against this env."
  value       = local.name_prefix
}

output "github_deploy_role_arn" {
  description = "Set as AWS_ROLE_ARN on this env's GitHub Environment. Null until github_repository is set."
  value       = one(module.github_deploy[*].role_arn)
}
