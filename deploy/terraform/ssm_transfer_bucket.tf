# amazon.aws.aws_ssm (the Ansible connection plugin used to reach this
# instance with no SSH key - see ansible/ansible.cfg) moves every file,
# including each Python module Ansible ships to the host, through an S3
# bucket as an intermediate hop. It is not the backups bucket on purpose:
# the plugin's own docs recommend versioning be OFF here, since a command's
# output can pass through this bucket in plaintext and versioning would
# keep old copies around - the opposite of what the backups bucket wants.
#
# This bucket needs no special IAM grant on the instance role: per the
# plugin's documentation, the instance receives a presigned URL and uses
# curl, so only the machine actually running `ansible-playbook` needs S3
# permissions here (s3:GetObject/PutObject/ListBucket/DeleteObject/
# GetBucketLocation) - granted to whoever/whatever runs Ansible, not
# provisioned by this Terraform.

resource "aws_s3_bucket" "ansible_transfer" {
  bucket = "${var.project}-ansible-transfer-${data.aws_caller_identity.current.account_id}"

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

resource "aws_s3_bucket_public_access_block" "ansible_transfer" {
  bucket = aws_s3_bucket.ansible_transfer.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# A safety net, not the primary cleanup mechanism - the connection plugin
# deletes its own files at the end of a run. This just makes sure nothing
# lingers if a run is killed mid-way.
resource "aws_s3_bucket_lifecycle_configuration" "ansible_transfer" {
  bucket = aws_s3_bucket.ansible_transfer.id

  rule {
    id     = "expire-leftover-transfers"
    status = "Enabled"

    filter {}

    expiration {
      days = 1
    }
  }
}
