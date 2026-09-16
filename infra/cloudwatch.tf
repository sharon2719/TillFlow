resource "aws_cloudwatch_log_group" "pos" {
  name              = "/${var.name_prefix}/pos"
  retention_in_days = 14

  tags = {
    service = "pos"
  }
}

resource "aws_cloudwatch_log_group" "pos_adot" {
  name              = "/${var.name_prefix}/pos-adot"
  retention_in_days = 14

  tags = {
    service = "pos"
  }
}

resource "aws_cloudwatch_log_group" "payments" {
  name              = "/${var.name_prefix}/payments"
  retention_in_days = 14

  tags = {
    service = "payments"
  }
}

resource "aws_cloudwatch_log_group" "payments_adot" {
  name              = "/${var.name_prefix}/payments-adot"
  retention_in_days = 14

  tags = {
    service = "payments"
  }
}

resource "aws_cloudwatch_log_group" "commission" {
  name              = "/${var.name_prefix}/commission"
  retention_in_days = 14

  tags = {
    service = "commission"
  }
}

resource "aws_cloudwatch_log_group" "commission_adot" {
  name              = "/${var.name_prefix}/commission-adot"
  retention_in_days = 14

  tags = {
    service = "commission"
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/${var.name_prefix}/web"
  retention_in_days = 14

  tags = {
    service = "web"
  }
}

resource "aws_cloudwatch_log_group" "web_adot" {
  name              = "/${var.name_prefix}/web-adot"
  retention_in_days = 14

  tags = {
    service = "web"
  }
}

# No _adot sibling: Grafana is a consumer of CloudWatch/X-Ray, not a traced business
# service, so it doesn't run the ADOT sidecar the other four do.
resource "aws_cloudwatch_log_group" "grafana" {
  name              = "/${var.name_prefix}/grafana"
  retention_in_days = 14

  tags = {
    service = "grafana"
  }
}
