resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

# Optional: only created when both an app_domain and a hosted zone are
# given. Without them, point your own DNS at the eip output, or just use
# the raw IP for a quick check.
resource "aws_route53_record" "app" {
  count = var.app_domain != "" && var.route53_zone_id != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.app_domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}
