# What goes wrong, and how you find out.
#
# The billing alarm says a month has gone wrong; these say an hour has.
# None of them cost anything: CloudWatch alarms are free up to ten per
# account, and these are five.
#
# An alarm and the topic it notifies must share a region, and billing
# metrics exist only in us-east-1 — so there are two topics when the relay
# runs anywhere else, and one when it doesn't.

locals {
  enabled = var.alert_email == "" ? 0 : 1
  # us-east-1 stacks need no second topic: the billing alarm can use the
  # regional one, because it is already the same region.
  billing_topic_is_separate = var.aws_region == "us-east-1" ? 0 : local.enabled
  billing_topic_arn         = local.billing_topic_is_separate == 1 ? one(aws_sns_topic.billing[*].arn) : one(aws_sns_topic.alarms[*].arn)
}

resource "aws_sns_topic" "alarms" {
  count = local.enabled
  name  = "${var.name_prefix}-alarms"
}

# Confirm by clicking the link AWS mails when this is first created —
# until then the subscription is pending and every alarm reaches nobody.
# State goes on saying pending long after it isn't, so replacing this
# unsubscribes a working address behind a plan that reads as harmless.
resource "aws_sns_topic_subscription" "alarms" {
  count     = local.enabled
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic" "billing" {
  count    = local.billing_topic_is_separate
  provider = aws.us_east_1
  name     = "${var.name_prefix}-billing-alarms"
}

resource "aws_sns_topic_subscription" "billing" {
  count     = local.billing_topic_is_separate
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.billing[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Month-to-date charges. Billing metrics are published a few times a day,
# so a shorter period would just re-read the same value.
resource "aws_cloudwatch_metric_alarm" "billing" {
  count               = local.enabled
  provider            = aws.us_east_1
  alarm_name          = "${var.name_prefix}-estimated-charges"
  alarm_description   = "Estimated charges for this account crossed $${var.billing_threshold_usd}."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  dimensions          = { Currency = "USD" }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.billing_threshold_usd
  period              = 21600
  evaluation_periods  = 1
  alarm_actions       = [local.billing_topic_arn]
}

# The one that matters most on a new account: the default Lambda
# concurrency limit is 10, so a modest spike returns 503s to real users
# while the billing alarm stays quiet.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  count               = local.enabled
  alarm_name          = "${var.name_prefix}-relay-throttles"
  alarm_description   = "The relay is being throttled — requests are failing, and the concurrency limit is the cause."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = var.function_name }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
}

# A deploy that crashes on every request looks fine from outside until
# someone tells you. Ten in five minutes, not one: a single failed request
# is ordinary.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count               = local.enabled
  alarm_name          = "${var.name_prefix}-relay-errors"
  alarm_description   = "The relay is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.function_name }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
}

# Fires before the timeout does: past 80% of it, requests are about to
# start failing rather than merely being slow.
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  count               = local.enabled
  alarm_name          = "${var.name_prefix}-relay-slow"
  alarm_description   = "The relay is close to its ${var.lambda_timeout_seconds}s timeout."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = var.function_name }
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.lambda_timeout_seconds * 1000 * 0.8
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
}

# On-demand tables throttle rarely, and when they do it is one partition
# doing the work of the whole table — a very busy circle, say.
resource "aws_cloudwatch_metric_alarm" "table_throttles" {
  for_each            = local.enabled == 1 ? toset(var.table_names) : toset([])
  alarm_name          = "${each.value}-throttles"
  alarm_description   = "DynamoDB is throttling ${each.value}."
  namespace           = "AWS/DynamoDB"
  metric_name         = "ThrottledRequests"
  dimensions          = { TableName = each.value }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
}
