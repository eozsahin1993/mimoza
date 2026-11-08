# The identity GitHub Actions deploys as: a role it assumes through OIDC,
# so nothing long-lived exists to leak. GitHub presents a signed token
# describing the repo, branch and environment; AWS checks it against the
# trust policy below and hands back credentials that expire in an hour.
#
# The boundary is that trust policy, not the permission set. Terraform
# manages IAM itself, so anything able to apply this configuration can
# grant itself the rest — a narrowly-scoped deploy policy would be theatre
# and would break every time a resource type is added.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # This repo's tokens carry immutable ids in the subject
    # (repo:<owner>@<owner id>/<repo>@<repo id>:…). Match them exactly: the
    # ids are what stop a lookalike account or repo name, and a wildcard in
    # their place let any GitHub user named eozsahin1993… assume this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${split("/", var.repository)[0]}@${var.owner_id}/${split("/", var.repository)[1]}@${var.repository_id}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-github-deploy"
  description        = "Assumed by GitHub Actions to deploy ${var.name_prefix}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
