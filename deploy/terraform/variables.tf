variable "aws_region" {
  description = "Where everything gets created."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for every resource, and the tag Ansible's dynamic inventory filters on."
  type        = string
  default     = "mini-chat"
}

variable "environment" {
  description = "A short environment name, used in tags and the SSM parameter path."
  type        = string
  default     = "prod"
}

variable "instance_type" {
  description = "One small instance. The app is one Node process writing to one SQLite file - more CPU than this buys nothing; more instances would break it (see data_volume.tf)."
  type        = string
  default     = "t3.small"
}

variable "data_volume_size_gb" {
  description = "Size of the persistent EBS volume holding the SQLite database (conversation memory + response cache)."
  type        = number
  default     = 20
}

variable "allowed_http_cidrs" {
  description = "Who can reach the app on 80/443. Defaults to everyone - narrow this to an office/VPN range for anything that isn't meant to be public."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "app_domain" {
  description = "Public DNS name for the app, e.g. chat.example.com. Leave blank to skip Route 53 and Let's Encrypt and serve plain HTTP from the instance's own address - fine for a first smoke test, not for real use."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Hosted zone to create the app_domain record in. Required only if app_domain is set and you want Terraform to manage the DNS record; leave blank to point your own DNS at the Elastic IP output manually."
  type        = string
  default     = ""
}

variable "letsencrypt_email" {
  description = "Contact address for the Let's Encrypt certificate. Required if app_domain is set."
  type        = string
  default     = ""
}

variable "ssm_parameter_path" {
  description = "SSM Parameter Store path prefix the instance is allowed to read secrets from (ANTHROPIC_API_KEY, OIDC_*, METRICS_TOKEN, ...). Create the parameters yourself first - see deploy/README.md. Terraform only grants read access to this path; it never holds a secret value."
  type        = string
  default     = "/mini-chat/prod"
}
