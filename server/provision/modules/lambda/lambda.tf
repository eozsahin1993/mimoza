# The pre-built Go binary — see build.sh. Terraform doesn't invoke `go
# build` itself (kept as a separate, explicit step rather than a
# provisioner): run ./build.sh before `terraform apply`/`terraform plan`
# whenever the Go source changes.
data "archive_file" "lambda" {
  type        = "zip"
  source_file = var.binary_path
  output_path = "${path.root}/.terraform/lambda.zip"
}

# Every relay setting that varies by env (sign-in client IDs, APNs IDs,
# limits), uploaded from server/<env>.env by push-config.sh. Read at apply
# time and baked into the function's environment under the same names —
# so a changed setting needs push-config.sh and then `terraform apply`.
data "aws_ssm_parameters_by_path" "config" {
  path = "/${var.name_prefix}/config"
}

locals {
  config = zipmap(
    [for name in data.aws_ssm_parameters_by_path.config.names : basename(name)],
    data.aws_ssm_parameters_by_path.config.values,
  )
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# One statement per table, each matching its store's calls exactly — no
# wildcard resource ARNs. LocalStack doesn't enforce IAM, so a missing
# action here passes every local test and only fails once deployed:
# re-check against the store when one gains a call.
data "aws_iam_policy_document" "lambda_storage_access" {
  # Every table, item-level only: no Scan (nothing enumerates a table —
  # deletes paginate a Query instead, see delete_circle.go), and no
  # table-level actions, so a compromised relay cannot drop or reconfigure
  # the store it reads. Index ARNs cover the two GSIs (DeleteEntry's
  # entryId lookup, DeleteAllSessions' accountId lookup).
  #
  # LocalStack doesn't enforce IAM, so a missing action here passes every
  # local test and only fails once deployed.
  statement {
    sid = "TableAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      # Only the sync log needs cross-item atomicity, but scoping one
      # action to one table is the precision this statement gave up.
      "dynamodb:TransactWriteItems",
    ]
    resources = flatten([
      for arn in [
        var.storage.table_arn,
        var.storage.sessions_table_arn,
        var.storage.accounts_table_arn,
        var.storage.circles_table_arn,
        var.storage.invite_table_arn,
        var.storage.rate_limit_table_arn,
        var.storage.push_table_arn,
      ] : [arn, "${arn}/index/*"]
    ])
  }

  statement {
    sid = "BlobAccess"
    actions = [
      # HeadObject as well as reads: the upload path checks for an
      # existing object, and deleteblob reads back the uploader recorded
      # on it.
      "s3:PutObject",
      "s3:GetObject",
      # A post's ciphertext, one at a time or in DeleteObjects batches —
      # never a log entry (see internal/synclog/http/deleteblob).
      "s3:DeleteObject",
    ]
    resources = ["${var.storage.bucket_arn}/*"]
  }

  # Deleting a circle lists everything under its prefix first — a
  # bucket-level action, so it can't share the object ARN above.
  statement {
    sid       = "BlobListAccess"
    actions   = ["s3:ListBucket"]
    resources = [var.storage.bucket_arn]
  }

  # The FCM service-account key, the APNs auth key and the Sign in with
  # Apple key, created by hand at /<prefix>/fcm-service-account,
  # /<prefix>/apns-auth-key and /<prefix>/apple-signin-key (the paths
  # internal/config derives) and deliberately not Terraform resources —
  # declaring them would put the values in state. Scoped to the named
  # parameters, not "*": the push keys can put arbitrary text on every
  # user's lock screen, and the sign-in key speaks for the app to Apple.
  statement {
    sid     = "PushCredentialAccess"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/fcm-service-account",
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/apns-auth-key",
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/apple-signin-key",
      # Signs blob download URLs — see internal/synclog/cdn.
      "arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/cloudfront-signing-key",
    ]
  }

  # Where the blob CDN is, written by modules/cdn because it knows and the
  # Lambda can't be told without a dependency cycle. Absent until blobs
  # move to CloudFront, which the relay treats as "keep presigning S3".
  statement {
    sid       = "BlobCDNSettings"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter/${var.name_prefix}/cdn"]
  }

  # Deleting a blob has to drop cached copies too, or the bytes outlive
  # the delete at the edge. Invalidation is the only CloudFront action the
  # relay ever takes, and it can't name the distribution: the ARN lives in
  # modules/cdn, which already depends on this module.
  statement {
    sid       = "BlobCacheInvalidation"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["*"]
  }

  # SecureStrings under the AWS-managed aws/ssm key: GetParameter's
  # WithDecryption decrypts as the caller, and only through SSM.
  statement {
    sid       = "PushCredentialDecrypt"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  # No IAM statement for Google/Apple sign-in verification — internal/
  # auth/oidcverify fetches each provider's JWKS over plain outbound HTTPS,
  # which needs no AWS permission at all (the Lambda has internet egress
  # by default outside a VPC).
}

resource "aws_iam_role_policy" "lambda_storage_access" {
  name   = "${var.name_prefix}-storage-access"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_storage_access.json
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/aws/lambda/${var.name_prefix}-relay"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "relay" {
  # So the group exists with its retention before the function can create
  # one without.
  depends_on = [aws_cloudwatch_log_group.relay]

  function_name = "${var.name_prefix}-relay"
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  # Custom runtime for a natively-compiled Go binary — see
  # server/cmd/lambda. "handler" is unused by provided runtimes (they just
  # exec ./bootstrap) but Terraform requires a value.
  runtime       = "provided.al2023"
  handler       = "bootstrap"
  architectures = ["arm64"]

  timeout     = 10
  memory_size = 256

  # AWS has no spending cap, and every table is PAY_PER_REQUEST — so this
  # is the only thing bounding how fast a runaway client or an abusive
  # caller can spend. Set well above real traffic: crossing it throttles
  # requests (503) rather than queueing them.
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    # Precedence, loosest first: SSM /config (operator-supplied values like
    # the sign-in client ids), then this env's settings, then the prefix
    # every name is derived from — which nothing may override.
    variables = merge(local.config, var.settings, { RESOURCE_PREFIX = var.name_prefix })
  }
}
