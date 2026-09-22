output "table_name" {
  value = aws_dynamodb_table.sync_log.name
}

output "table_arn" {
  value = aws_dynamodb_table.sync_log.arn
}

output "bucket_name" {
  value = aws_s3_bucket.blobs.id
}

output "bucket_arn" {
  value = aws_s3_bucket.blobs.arn
}

output "bucket_regional_domain_name" {
  value = aws_s3_bucket.blobs.bucket_regional_domain_name
}

output "invite_table_name" {
  value = aws_dynamodb_table.invites.name
}

output "invite_table_arn" {
  value = aws_dynamodb_table.invites.arn
}

output "sessions_table_name" {
  value = aws_dynamodb_table.sessions.name
}

output "sessions_table_arn" {
  value = aws_dynamodb_table.sessions.arn
}

output "accounts_table_name" {
  value = aws_dynamodb_table.accounts.name
}

output "accounts_table_arn" {
  value = aws_dynamodb_table.accounts.arn
}

output "circles_table_name" {
  value = aws_dynamodb_table.circles.name
}

output "circles_table_arn" {
  value = aws_dynamodb_table.circles.arn
}

output "rate_limit_table_name" {
  value = aws_dynamodb_table.rate_limit.name
}

output "rate_limit_table_arn" {
  value = aws_dynamodb_table.rate_limit.arn
}

output "push_table_name" {
  value = aws_dynamodb_table.push.name
}

output "push_table_arn" {
  value = aws_dynamodb_table.push.arn
}

output "table_names" {
  description = "Every table, for alarms that watch the lot."
  value = [
    aws_dynamodb_table.sync_log.name,
    aws_dynamodb_table.invites.name,
    aws_dynamodb_table.sessions.name,
    aws_dynamodb_table.accounts.name,
    aws_dynamodb_table.circles.name,
    aws_dynamodb_table.rate_limit.name,
    aws_dynamodb_table.push.name,
  ]
}
