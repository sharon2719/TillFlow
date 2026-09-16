# G3 (Operate): turns docs/slo-error-budgets.md from a written table into alarms someone
# actually gets paged by. These alarm on ALB/RDS metrics - infra-level signals available
# today, not the SLO table's exact numerators (e.g. "valid sale writes accepted exactly
# once"), which would need custom app-level metrics no service emits yet. That gap is
# tracked in docs/production-readiness.md, not silently assumed away. Until then, these are
# the closest real proxy: 5xx rate and ALB-observed latency approximate "is the API healthy
# and fast", unhealthy-host count approximates "is the service actually up".

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"
  # AWS-managed key - CloudWatch's own service-linked permission to publish here doesn't
  # need a separate key policy grant, unlike a customer-managed CMK would.
  kms_master_key_id = "alias/aws/sns"

  tags = {
    service = "platform"
  }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "tillflow4@gmail.com"
}

# --- pos: SLO target is p95 < 400ms (docs/slo-error-budgets.md) ---

resource "aws_cloudwatch_metric_alarm" "pos_5xx" {
  alarm_name          = "${var.name_prefix}-pos-5xx"
  alarm_description   = "pos target group returned a 5xx - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "pos"
  }
}

resource "aws_cloudwatch_metric_alarm" "pos_latency" {
  alarm_name          = "${var.name_prefix}-pos-latency-p95"
  alarm_description   = "pos p95 response time over its 400ms SLO target - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 0.4
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "pos"
  }
}

# unhealthy-host alarms use a 2-minute evaluation window (not the more common 5) because
# desired_count is 1 everywhere - a normal rolling deploy briefly shows the target
# unhealthy while the old task drains and the new one starts, and a single 1-minute blip
# shouldn't page anyone. 2 consecutive minutes catches a genuinely stuck deployment or a
# real outage without alarming on every routine release.
resource "aws_cloudwatch_metric_alarm" "pos_unhealthy" {
  alarm_name          = "${var.name_prefix}-pos-unhealthy"
  alarm_description   = "pos has no healthy targets behind the ALB - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "pos"
  }
}

# --- payments: SLO target is commands+callbacks resolving within 60s, not raw HTTP
# latency - the p95 threshold here is a generic "is this endpoint responsive" health check,
# not a direct measurement of that SLO (see file header). ---

resource "aws_cloudwatch_metric_alarm" "payments_5xx" {
  alarm_name          = "${var.name_prefix}-payments-5xx"
  alarm_description   = "payments target group returned a 5xx - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "payments"
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_latency" {
  alarm_name          = "${var.name_prefix}-payments-latency-p95"
  alarm_description   = "payments p95 response time elevated - generic health signal, see file header in infra/monitoring.tf"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "payments"
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_unhealthy" {
  alarm_name          = "${var.name_prefix}-payments-unhealthy"
  alarm_description   = "payments has no healthy targets behind the ALB - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "payments"
  }
}

# --- commission: same as payments, its SLO is about payouts reaching a terminal state by
# 06:30 EAT, not raw HTTP latency. ---

resource "aws_cloudwatch_metric_alarm" "commission_5xx" {
  alarm_name          = "${var.name_prefix}-commission-5xx"
  alarm_description   = "commission target group returned a 5xx - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "commission"
  }
}

resource "aws_cloudwatch_metric_alarm" "commission_latency" {
  alarm_name          = "${var.name_prefix}-commission-latency-p95"
  alarm_description   = "commission p95 response time elevated - generic health signal, see file header in infra/monitoring.tf"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "commission"
  }
}

resource "aws_cloudwatch_metric_alarm" "commission_unhealthy" {
  alarm_name          = "${var.name_prefix}-commission-unhealthy"
  alarm_description   = "commission has no healthy targets behind the ALB - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "commission"
  }
}

# --- web: SLO target is p95 < 500ms ---

resource "aws_cloudwatch_metric_alarm" "web_5xx" {
  alarm_name          = "${var.name_prefix}-web-5xx"
  alarm_description   = "web target group returned a 5xx - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "web"
  }
}

resource "aws_cloudwatch_metric_alarm" "web_latency" {
  alarm_name          = "${var.name_prefix}-web-latency-p95"
  alarm_description   = "web p95 response time over its 500ms SLO target - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 0.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "web"
  }
}

resource "aws_cloudwatch_metric_alarm" "web_unhealthy" {
  alarm_name          = "${var.name_prefix}-web-unhealthy"
  alarm_description   = "web has no healthy targets behind the ALB - see docs/runbook.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "web"
  }
}

# --- RDS: the one shared dependency behind pos/payments/commission - a single instance, so
# its health affects three services' error budgets at once. ---

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu"
  alarm_description   = "RDS CPU utilization over 80% for 15 minutes - see docs/runbook.md"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "platform"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name_prefix}-rds-free-storage"
  alarm_description   = "RDS free storage below 2GB (of 20GB allocated) - see docs/runbook.md"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2147483648 # 2 GiB, in bytes - this metric's native unit
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "platform"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name_prefix}-rds-connections"
  alarm_description   = "RDS connection count unusually high for db.t4g.micro - see docs/runbook.md"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  tags = {
    service = "platform"
  }
}

# --- One dashboard covering every service + RDS, so "is the system healthy right now" is a
# single link (docs/runbook.md), not four separate CloudWatch metric searches. ---

resource "aws_cloudwatch_dashboard" "overview" {
  dashboard_name = "${var.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 1
        properties = {
          markdown = "# TillFlow (${var.name_prefix}) - operational overview. See docs/runbook.md and docs/slo-error-budgets.md."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 1
        width  = 12
        height = 6
        properties = {
          title  = "5xx count by service (5 min sum)"
          region = var.region
          view   = "timeSeries"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "pos" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.payments.arn_suffix, { label = "payments" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.commission.arn_suffix, { label = "commission" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.web.arn_suffix, { label = "web" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 1
        width  = 12
        height = 6
        properties = {
          title  = "p95 response time by service (SLO targets: pos 400ms, web 500ms)"
          region = var.region
          view   = "timeSeries"
          stat   = "p95"
          period = 300
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "pos" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.payments.arn_suffix, { label = "payments" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.commission.arn_suffix, { label = "commission" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.web.arn_suffix, { label = "web" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 12
        height = 6
        properties = {
          title  = "Healthy hosts by service (should be 1 outside a deploy)"
          region = var.region
          view   = "timeSeries"
          stat   = "Average"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "pos" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.payments.arn_suffix, { label = "payments" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.commission.arn_suffix, { label = "commission" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.web.arn_suffix, { label = "web" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 7
        width  = 12
        height = 6
        properties = {
          title  = "RDS: CPU %, free storage (bytes), connections"
          region = var.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "CPU %", stat = "Average" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "connections", stat = "Average", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
