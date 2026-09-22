# CloudFront over the blob bucket. Every member of a circle downloads the
# same ciphertext, so the second reader onward should be served from an
# edge rather than S3 — bandwidth, and the latency that actually shows up
# for someone far from the origin.
#
# Reads move from presigned S3 GETs to CloudFront signed URLs; uploads
# stay presigned S3 POSTs straight to the bucket, so this is download-only.

locals {
  blobs_enabled  = var.blob_domain_name == "" ? 0 : 1
  blob_origin_id = "${var.name_prefix}-blobs"
}

# Signature parameters (Expires, Key-Pair-Id, Policy, Signature) are
# stripped before the origin sees them, and query strings are out of the
# cache key entirely — which is the whole point: five members holding five
# differently-signed URLs must share one cached object.
resource "aws_cloudfront_cache_policy" "blobs" {
  count       = local.blobs_enabled
  name        = "${var.name_prefix}-blobs"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip = false

    query_strings_config {
      query_string_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# The relay signs with the matching private key, held in SSM like the push
# credentials — hand-created, never Terraform-managed.
resource "aws_cloudfront_public_key" "blobs" {
  count       = local.blobs_enabled
  name        = "${var.name_prefix}-blobs"
  encoded_key = var.blob_signing_public_key
  comment     = "Signs blob download URLs for ${var.name_prefix}"

  lifecycle {
    precondition {
      condition     = var.blob_signing_public_key != ""
      error_message = "blob_domain_name needs blob_signing_public_key: generate a key pair, keep the private half in SSM, pass the public half here."
    }
  }
}

resource "aws_cloudfront_key_group" "blobs" {
  count = local.blobs_enabled
  name  = "${var.name_prefix}-blobs"
  items = [aws_cloudfront_public_key.blobs[0].id]
}

# Lets the distribution — and nothing else — read the bucket, so an
# unsigned request can't reach S3 directly and bypass the key group.
resource "aws_cloudfront_origin_access_control" "blobs" {
  count                             = local.blobs_enabled
  name                              = "${var.name_prefix}-blobs"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "blobs" {
  count   = local.blobs_enabled
  enabled = true
  comment = "${var.name_prefix} blobs"
  aliases = [var.blob_domain_name]

  origin {
    origin_id                = local.blob_origin_id
    domain_name              = var.blob_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.blobs[0].id
  }

  default_cache_behavior {
    target_origin_id       = local.blob_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    # Ciphertext doesn't compress.
    compress           = false
    cache_policy_id    = aws_cloudfront_cache_policy.blobs[0].id
    trusted_key_groups = [aws_cloudfront_key_group.blobs[0].id]
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

data "aws_iam_policy_document" "blobs_bucket" {
  count = local.blobs_enabled

  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${var.blob_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.blobs[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "blobs" {
  count  = local.blobs_enabled
  bucket = var.blob_bucket_name
  policy = data.aws_iam_policy_document.blobs_bucket[0].json
}

# What the relay needs to serve blobs from here, handed over through SSM
# rather than the Lambda's environment: the distribution needs the
# function's URL, so a Lambda told these in its own environment would
# close a dependency cycle. Terraform writes what it created; the relay
# reads it at runtime (internal/synclog/cdn).
#
# One parameter rather than three, so the relay reads once and can never
# see a half-updated set. A plain String — none of this is secret, unlike
# the signing key beside it.
resource "aws_ssm_parameter" "blob_cdn" {
  count = local.blobs_enabled
  name  = "/${var.name_prefix}/cdn"
  type  = "String"
  value = jsonencode({
    baseUrl        = "https://${var.blob_domain_name}"
    keyPairId      = aws_cloudfront_public_key.blobs[0].id
    distributionId = aws_cloudfront_distribution.blobs[0].id
  })
}
