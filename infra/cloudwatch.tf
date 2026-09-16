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
