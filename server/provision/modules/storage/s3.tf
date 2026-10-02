# Holds mostly encrypted ciphertext the relay itself can never read, plus
# one disclosed exception: a profile picture, stored as uploaded rather
# than sealed (see RELAY_DESIGN.md's trust model). Stays private
# regardless: access is entirely gated by short-lived presigned URLs,
# never by bucket policy or public access.
resource "aws_s3_bucket" "blobs" {
  bucket        = "${var.name_prefix}-blobs"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "blobs" {
  bucket = aws_s3_bucket.blobs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Presigned PUT/GET need CORS to work from a browser context (e.g. Expo
# web) — native mobile HTTP clients don't enforce CORS, but this covers
# both without needing to know which client is uploading. Access is
# already gated by whoever holds the one-time presigned URL, not by
# origin — a plain <img> load needs no CORS at all — so a permissive
# origin list doesn't open a path that wasn't already open, ciphertext
# or the one disclosed exception (a profile picture).
resource "aws_s3_bucket_cors_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id

  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Blobs never expire on a timer — permanent retention, same as the log
# entries that point to them.
# Affordable via tiering, not eviction: after blob_glacier_transition_days,
# objects move to Glacier Instant Retrieval — same millisecond-latency
# access as Standard, ~6x cheaper per GB. Defaults to Glacier IR's own
# 90-day minimum billable duration.
#
# They are deletable on request, which is a different thing from expiry:
# deleting a photo removes its object then and there (see
# internal/synclog/http/deleteblob), so nothing outlives the post it belonged to,
# and deleting a circle takes everything under its prefix (see
# internal/synclog/http/deletecircle).
#
# Versioning is deliberately off. With it on, those deletes would lay down
# delete markers over recoverable versions and quietly stop destroying
# anything.
resource "aws_s3_bucket_lifecycle_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id

  rule {
    id     = "archive-blobs"
    status = "Enabled"

    filter {}

    transition {
      days          = var.blob_glacier_transition_days
      storage_class = "GLACIER_IR"
    }
  }
}
