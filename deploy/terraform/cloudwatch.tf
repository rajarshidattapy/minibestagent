# Where the CloudWatch agent (installed by the Ansible `cloudwatch` role)
# ships the app's systemd journal and nginx logs. Kept deliberately small -
# this is "can I see what happened after the fact", not a metrics stack.
# For metrics, GET /api/metrics already serves Prometheus exposition text;
# scrape it from wherever you run Prometheus, or point an
# AWS-managed Prometheus workspace at this same instance - that is a
# separate, optional piece this Terraform does not provision.

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/${var.environment}/app"
  retention_in_days = 30

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${var.project}-instance-status-check-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "The instance itself (not the app) has failed an AWS status check."

  dimensions = {
    InstanceId = aws_instance.app.id
  }

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}
