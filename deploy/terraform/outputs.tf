output "aws_region" {
  value = var.aws_region
}

output "public_ip" {
  description = "Where the app is reachable if app_domain was not set."
  value       = aws_eip.app.public_ip
}

output "app_url" {
  description = "Where the app is actually reachable."
  value       = var.app_domain != "" ? "https://${var.app_domain}" : "http://${aws_eip.app.public_ip}"
}

output "instance_id" {
  description = "Target for `aws ssm start-session --target <this>`, and what Ansible's dynamic inventory resolves to."
  value       = aws_instance.app.id
}

output "backups_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "ansible_transfer_bucket" {
  description = "Feed this to ansible_aws_ssm_bucket_name in ansible/ansible.cfg or group_vars."
  value       = aws_s3_bucket.ansible_transfer.bucket
}

output "ssm_parameter_path" {
  description = "Create ANTHROPIC_API_KEY, OIDC_*, METRICS_TOKEN etc. as SecureString parameters under this path before running Ansible - see deploy/README.md."
  value       = var.ssm_parameter_path
}
