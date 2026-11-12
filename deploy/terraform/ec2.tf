data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# user_data does the bare minimum needed for Ansible to take over: a
# Python interpreter (Ansible's default connection needs one) and nothing
# else. Formatting and mounting the data volume is deliberately NOT here -
# it happens once, idempotently, in the Ansible `common` role
# (ansible.builtin.filesystem refuses to reformat a volume that already has
# a filesystem on it). A shell script that runs `mkfs` on every boot would
# be a one-line way to destroy the database the first time this instance
# gets rebooted or replaced.
locals {
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    apt-get update
    apt-get install -y python3
  EOT
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  availability_zone      = local.availability_zone
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  user_data              = local.user_data

  # SSM Session Manager is how this instance is reached - no key pair.
  key_name = null

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  metadata_options {
    # IMDSv2 only - the classic SSRF-to-credential-theft path needs v1.
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = {
    Project     = var.project
    Environment = var.environment
    Name        = "${var.project}-${var.environment}"
    # This is the tag deploy/ansible/inventory/aws_ec2.yml filters on -
    # Ansible always targets exactly what Terraform created, with nothing
    # to keep in sync by hand.
  }
}
