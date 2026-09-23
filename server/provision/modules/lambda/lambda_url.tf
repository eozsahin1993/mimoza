# One Lambda handling every endpoint (its own net/http.ServeMux does the
# real routing internally — see server/internal/app), reachable at a
# single URL. A Function URL is just a dedicated HTTPS endpoint attached
# directly to the function; API Gateway would earn its keep only for
# multi-function routing or WebSocket. The custom domain that used to
# argue for it is handled by CloudFront instead (modules/cdn).
resource "aws_lambda_function_url" "relay" {
  function_name = aws_lambda_function.relay.function_name

  # Behind CloudFront the URL is signed by the distribution's origin
  # access control, so a direct caller who learns this hostname gets 403
  # — without it they would bypass the CDN and anything attached to it.
  # Unsigned is the only option until a distribution exists to do the
  # signing: flipping this with nothing in front makes the relay
  # unreachable.
  authorization_type = var.behind_cloudfront ? "AWS_IAM" : "NONE"
}

# Function URLs are invoked directly, not via API Gateway, so they need
# their own resource-based permission — distinct action/condition from the
# ordinary "apigateway.amazonaws.com can invoke this" grant.
#
# The signed counterpart lives in modules/cdn, which knows the
# distribution ARN to scope it to. Granting it here would need that ARN
# too, and the distribution already needs this function's URL — a cycle.
resource "aws_lambda_permission" "function_url" {
  count                  = var.behind_cloudfront ? 0 : 1
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.relay.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Both actions are required for an unauthenticated URL: with only
# InvokeFunctionUrl granted, every request comes back 403
# AccessDeniedException and the function is never reached, so there is
# nothing in its logs to explain why.
resource "aws_lambda_permission" "function_url_invoke" {
  count         = var.behind_cloudfront ? 0 : 1
  statement_id  = "AllowFunctionUrlInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.relay.function_name
  principal     = "*"
}
