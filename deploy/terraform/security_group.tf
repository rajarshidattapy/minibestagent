# No port 22, anywhere, ever. Shell access goes over AWS Systems Manager
# Session Manager (see iam.tf) - it tunnels through the AWS API using the
# instance's own IAM role, so there is no key pair to generate, distribute,
# rotate, or leak, and no open inbound SSH port for the internet to find.
# Ansible connects the same way (see ansible/ansible.cfg).

resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "Inbound web traffic only; everything else (including SSH) goes over SSM."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (redirects to HTTPS once a domain + cert are configured)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }

  egress {
    description = "The app calls the Anthropic API, OIDC issuer, and S3 for backups - all outbound, nothing to restrict by port here."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}
