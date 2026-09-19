locals {
  env         = "staging"
  aws_region  = "us-east-1"
  name_prefix = "mimoza-${local.env}"
  # Every hostname is derived from the environment's own domain, so there
  # is one value to set and one certificate to validate.
  api_domain  = var.env_domain == "" ? "" : "api.${var.env_domain}"
  blob_domain = var.env_domain == "" ? "" : "cdn.${var.env_domain}"
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix

  deletion_protection = false
}

module "lambda" {
  source      = "../../modules/lambda"
  name_prefix = local.name_prefix
  aws_region  = local.aws_region
  binary_path = "${path.root}/../../build/bootstrap"
  storage     = module.storage

  # Permanent, not pending: locking the URL makes Lambda demand a body hash
  # on every write, and only the app is in a position to add it.
  behind_cloudfront = false

  # Starting guesses, not measurements — see internal/config. Here rather
  # than in <env>.env so a change to them is a diff someone can review.
  settings = {
    MAX_BLOB_SIZE_BYTES           = "2097152"
    INVITE_RETENTION_DAYS         = "7"
    RATE_LIMIT_WRITE_MAX_REQUESTS = "500"
    RATE_LIMIT_READ_MAX_REQUESTS  = "2000"
    RATE_LIMIT_PUSH_MAX_REQUESTS  = "500"
    RATE_LIMIT_WINDOW_MINUTES     = "10"
  }
  # -1 leaves it unset, which a new account needs: the default limit is 10
  # concurrent executions, and AWS refuses a reservation that drops the
  # unreserved pool below that.
  reserved_concurrency = -1
}

# One certificate for the whole environment; every hostname below lives
# under it, so adding a service needs no new validation record.
module "certificate" {
  count  = var.env_domain == "" ? 0 : 1
  source = "../../modules/certificate"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  domain = var.env_domain
}

module "cdn" {
  source = "../../modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix          = local.name_prefix
  origin_url           = module.lambda.api_endpoint
  origin_function_name = module.lambda.function_name

  certificate_arn         = one(module.certificate[*].arn)
  api_domain_name         = local.api_domain
  sign_origin_requests    = false
  blob_domain_name        = local.blob_domain
  blob_signing_public_key = local.blob_domain == "" ? "" : file("${path.module}/cloudfront-signing-key.pub")

  blob_bucket_name                 = module.storage.bucket_name
  blob_bucket_arn                  = module.storage.bucket_arn
  blob_bucket_regional_domain_name = module.storage.bucket_regional_domain_name
}

module "alarms" {
  source = "../../modules/alarms"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix   = local.name_prefix
  aws_region    = local.aws_region
  alert_email   = var.alert_email
  function_name = module.lambda.function_name
  table_names   = module.storage.table_names

  billing_threshold_usd = 10
}

module "github_deploy" {
  source = "../../modules/github-deploy"

  name_prefix = local.name_prefix
  repository  = var.github_repository
  environment = "staging"
}
