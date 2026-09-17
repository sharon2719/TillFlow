# Fast/slow burn-rate alerting (Google SRE workbook pattern), on top of the flat-threshold
# alarms in infra/monitoring.tf. Burn rate = observed error rate / error budget - a burn
# rate of 14.4x means the 28-day budget in docs/slo-error-budgets.md would be exhausted in
# under 2 days at that rate, which is the standard "page now" threshold; 3x is the standard
# "ticket, not a page" threshold. Same proxy-metric caveat as every other alarm in this
# stack: this is built on ALB 5xx-rate, not the SLO table's literal numerators (e.g. "valid
# sale writes accepted exactly once") - see docs/production-readiness.md. commission
# specifically has no real HTTP-traffic-shaped SLI at all (its SLO is about payout timing
# and duplicate-freedom, not request success rate), so its burn-rate alarms here are the
# roughest proxy of the four - kept for consistency, not because the number is meaningful
# on its own.
#
# Single-window per tier (not the full 4-window Google pattern, which pairs a short window
# with a longer corroborating one per tier) - a deliberate simplification given these are
# already proxy metrics; the extra rigor of a second corroborating window buys less when
# the underlying signal is approximate to begin with.

locals {
  # SLO budgets from docs/slo-error-budgets.md, as a fraction (not the deployment default -
  # tenantId/attendantId flavor - just the raw number here).
  slo_budget = {
    pos        = 0.001 # 99.9%
    web        = 0.001 # 99.9%
    payments   = 0.005 # 99.5%
    commission = 0.01  # 99.0%
  }
}

# --- pos ---

resource "aws_cloudwatch_metric_alarm" "pos_fast_burn" {
  alarm_name          = "${var.name_prefix}-pos-fast-burn"
  alarm_description   = "pos error-rate burn rate >= 14.4x its budget over 5m - would exhaust the 28-day budget in under 2 days. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 14.4 * local.slo_budget["pos"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "pos 5xx error rate % (5m)"
    return_data = true
  }

  tags = { service = "pos" }
}

resource "aws_cloudwatch_metric_alarm" "pos_slow_burn" {
  alarm_name          = "${var.name_prefix}-pos-slow-burn"
  alarm_description   = "pos error-rate burn rate >= 3x its budget over 1h - ticket, not a page. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3 * local.slo_budget["pos"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.pos.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "pos 5xx error rate % (1h)"
    return_data = true
  }

  tags = { service = "pos" }
}

# --- web ---

resource "aws_cloudwatch_metric_alarm" "web_fast_burn" {
  alarm_name          = "${var.name_prefix}-web-fast-burn"
  alarm_description   = "web error-rate burn rate >= 14.4x its budget over 5m - would exhaust the 28-day budget in under 2 days. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 14.4 * local.slo_budget["web"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "web 5xx error rate % (5m)"
    return_data = true
  }

  tags = { service = "web" }
}

resource "aws_cloudwatch_metric_alarm" "web_slow_burn" {
  alarm_name          = "${var.name_prefix}-web-slow-burn"
  alarm_description   = "web error-rate burn rate >= 3x its budget over 1h - ticket, not a page. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3 * local.slo_budget["web"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "web 5xx error rate % (1h)"
    return_data = true
  }

  tags = { service = "web" }
}

# --- payments ---

resource "aws_cloudwatch_metric_alarm" "payments_fast_burn" {
  alarm_name          = "${var.name_prefix}-payments-fast-burn"
  alarm_description   = "payments error-rate burn rate >= 14.4x its budget over 5m - would exhaust the 28-day budget in under 2 days. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 14.4 * local.slo_budget["payments"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "payments 5xx error rate % (5m)"
    return_data = true
  }

  tags = { service = "payments" }
}

resource "aws_cloudwatch_metric_alarm" "payments_slow_burn" {
  alarm_name          = "${var.name_prefix}-payments-slow-burn"
  alarm_description   = "payments error-rate burn rate >= 3x its budget over 1h - ticket, not a page. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3 * local.slo_budget["payments"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.payments.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "payments 5xx error rate % (1h)"
    return_data = true
  }

  tags = { service = "payments" }
}

# --- commission (roughest proxy of the four - see file header) ---

resource "aws_cloudwatch_metric_alarm" "commission_fast_burn" {
  alarm_name          = "${var.name_prefix}-commission-fast-burn"
  alarm_description   = "commission error-rate burn rate >= 14.4x its budget over 5m - crude proxy, commission's real SLI is payout timing/duplicates, not HTTP error rate. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 14.4 * local.slo_budget["commission"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "commission 5xx error rate % (5m)"
    return_data = true
  }

  tags = { service = "commission" }
}

resource "aws_cloudwatch_metric_alarm" "commission_slow_burn" {
  alarm_name          = "${var.name_prefix}-commission-slow-burn"
  alarm_description   = "commission error-rate burn rate >= 3x its budget over 1h - ticket, not a page. See docs/runbook.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3 * local.slo_budget["commission"] * 100
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCountPerTarget"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.commission.arn_suffix }
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(FILL(requests, 0) > 0, (FILL(errors, 0) / requests) * 100, 0)"
    label       = "commission 5xx error rate % (1h)"
    return_data = true
  }

  tags = { service = "commission" }
}
