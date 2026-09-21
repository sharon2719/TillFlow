# Works around a confirmed, unexplained account-level gap (docs/recovery-drills.md drill 2):
# a real CloudWatch alarm reaching ALARM/OK does not result in CloudWatch calling
# sns:Publish on this account, despite every alarm having ActionsEnabled=true and a
# correctly-configured AlarmActions/OKActions pointing at aws_sns_topic.alerts. Confirmed NOT
# a KMS/encryption issue for this specific mechanism: a live diagnostic (a brand-new
# UNENCRYPTED test topic + a brand-new test alarm pointed at it) still produced zero
# publish - CloudWatch's own native alarm-action invocation is broken for a still-unknown
# reason, unrelated to the topic's encryption.
#
# The fix: don't depend on that mechanism at all. EventBridge has built-in, independent
# support for "CloudWatch Alarm State Change" events (source: aws.cloudwatch) - a completely
# different code path from an alarm's own AlarmActions/OKActions. This rule catches every
# devops-g5-* alarm's state change and republishes it to the SAME alerts SNS topic, in the
# SAME JSON shape infra/lambda/slack-notifier/index.mjs already expects
# (AlarmName/NewStateValue/NewStateReason) via an input transformer - so neither the Lambda
# nor the email subscription needs any change, only the delivery path underneath them does.
#
# This path had its OWN KMS problem, separately diagnosed and fixed: EventBridge targeting
# the real (then KMS-encrypted) alerts topic also produced zero publish - a second live
# diagnostic (a temporary EventBridge target on a fresh encrypted topic vs. an identical one
# on a fresh unencrypted topic) isolated encryption specifically as EventBridge's blocker,
# confirmed by the unencrypted case delivering on the first try. Fixed by removing
# aws_sns_topic.alerts's KMS encryption entirely (see monitoring.tf's own comment on that
# resource) - which is why this rule's target works against that topic at all.

resource "aws_cloudwatch_event_rule" "alarm_state_change" {
  name        = "${var.name_prefix}-alarm-state-change"
  description = "Routes around CloudWatch's own broken native alarm-to-SNS action (see this file's header) - docs/recovery-drills.md drill 2"

  event_pattern = jsonencode({
    source      = ["aws.cloudwatch"]
    detail-type = ["CloudWatch Alarm State Change"]
    resources = [{
      # Hardcoded account ID, matching this repo's existing convention elsewhere (see
      # infra/iam.tf) rather than introducing a new aws_caller_identity data source just for
      # this.
      prefix = "arn:aws:cloudwatch:${var.region}:240462142849:alarm:${var.name_prefix}-"
    }]
  })

  tags = {
    service = "platform"
  }
}

resource "aws_cloudwatch_event_target" "alarm_state_change_to_sns" {
  rule = aws_cloudwatch_event_rule.alarm_state_change.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      alarmName = "$.detail.alarmName"
      state     = "$.detail.state.value"
      reason    = "$.detail.state.reason"
    }
    # Deliberately the same field names/shape CloudWatch's own native SNS action would have
    # produced (AlarmName/NewStateValue/NewStateReason) - infra/lambda/slack-notifier's
    # handler and anyone reading the raw email both already expect this shape.
    input_template = "{\"AlarmName\": <alarmName>, \"NewStateValue\": <state>, \"NewStateReason\": <reason>}"
  }
}

# EventBridge needs explicit permission to publish to this topic. Attaching an
# aws_sns_topic_policy REPLACES the topic's SNS-auto-generated default policy entirely (only
# one policy can be attached at a time) - so this restates that default statement (Principal
# "*" scoped to same-account callers via aws:SourceOwner, the same grant that already let a
# direct `aws sns publish` test succeed) rather than silently narrowing what could publish
# here before, and adds the new EventBridge-specific statement alongside it.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "auto-generated-default-plus-eventbridge"
    Statement = [
      {
        Sid       = "SameAccountDefault"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action = [
          "SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission",
          "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe",
          "SNS:ListSubscriptionsByTopic", "SNS:Publish",
        ]
        Resource  = aws_sns_topic.alerts.arn
        Condition = { StringEquals = { "AWS:SourceOwner" = "240462142849" } }
      },
      {
        Sid       = "AllowEventBridgeAlarmBridge"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          ArnLike = { "aws:SourceArn" = aws_cloudwatch_event_rule.alarm_state_change.arn }
        }
      }
    ]
  })
}
