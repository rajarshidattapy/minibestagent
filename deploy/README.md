# Deploying mini-chat to AWS

Terraform provisions what exists: one EC2 instance, its data volume, its IAM role, the S3 buckets, the log group. Ansible configures what runs on it: Node, the app itself, nginx, TLS, the nightly backup, the CloudWatch agent. Each tool does the half it's actually good at - nothing here asks Terraform to configure software, and nothing asks Ansible to own infrastructure it didn't create.

## Why one instance, not Fargate or an auto-scaling group

This app keeps its conversation memory and response cache in one local SQLite file (`lib/db.ts`). That is a deliberate, already-made design decision, not an oversight this deploy works around - and it means the infrastructure has to match it: one process, one disk, not stateless serverless compute with an ephemeral filesystem, and not a second instance that would just be a second, inconsistent copy of someone's history. If this app is ever rearchitected onto Postgres + Redis (see `DESIGN.md`'s "what I'd do with another week"), *that* is the point at which more than one instance starts making sense - not before.

## What's deliberately not here

- **No VPC module, no private subnets, no NAT gateway, no ALB.** The default VPC and a single public instance are the right scope for one box; a dedicated VPC and a load balancer in front of it are the right call once there's a second instance to isolate traffic across, which this design doesn't have.
- **No SSH key pair, anywhere.** Every connection - Ansible's and yours - goes through AWS Systems Manager Session Manager, using the instance's own IAM role. There is nothing to generate, distribute, rotate, or leak, and no open inbound port 22 for the internet to find.
- **No secret ever touches Terraform state or this git history.** Secrets live in SSM Parameter Store, created by hand before the first `ansible-playbook` run, and are pulled onto the instance *by the instance's own IAM role* at deploy time - not by the Ansible controller, which never needs to read them at all.

## Prerequisites

On whatever machine runs Terraform and Ansible (your laptop is fine):

- Terraform >= 1.7, and AWS credentials with enough access to create the resources in `terraform/` (an administrator role is the easy answer for a first pass; scope it down once this is real).
- The [Session Manager plugin for the AWS CLI](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) - required by the `amazon.aws.aws_ssm` connection plugin Ansible uses to reach the instance.
- Python 3 with `boto3` and `botocore` installed, and:
  ```bash
  pip install ansible-core
  ansible-galaxy collection install -r ansible/requirements.yml
  ```

## 1. Provision the infrastructure

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # edit it
terraform init
terraform apply
```

Take note of the outputs - the next two steps need several of them.

## 2. Create the secrets (once, by hand, never in this repo)

Terraform's IAM policy only grants the instance read access to one SSM path; it never creates the parameters themselves, on purpose - that's the one step with no automation, so a secret is never one `git diff` away from being visible.

```bash
PATH_PREFIX=$(terraform -chdir=terraform output -raw ssm_parameter_path)

aws ssm put-parameter --name "$PATH_PREFIX/ANTHROPIC_API_KEY" \
  --type SecureString --value "sk-ant-..."

# Optional - only if you want OAuth2/OIDC enforced (see the project's own
# .env.example for what each of these means). Skip all of them and the app
# runs with AUTH_OPTIONAL-style defaults.
aws ssm put-parameter --name "$PATH_PREFIX/OIDC_ISSUER" --type SecureString --value "https://your-issuer/"
aws ssm put-parameter --name "$PATH_PREFIX/OIDC_AUDIENCE" --type SecureString --value "https://api.your-app/"
aws ssm put-parameter --name "$PATH_PREFIX/METRICS_TOKEN" --type SecureString --value "$(openssl rand -hex 32)"
```

Every parameter under this path is pulled onto the instance as an environment variable named after the parameter's own last path segment - add or remove parameters here, not in Ansible, to change what the app sees.

## 3. Configure the instance

```bash
cd ansible

export AWS_DEFAULT_REGION=$(terraform -chdir=../terraform output -raw aws_region)
export ANSIBLE_AWS_SSM_BUCKET=$(terraform -chdir=../terraform output -raw ansible_transfer_bucket)
export SSM_PARAMETER_PATH=$(terraform -chdir=../terraform output -raw ssm_parameter_path)
export BACKUPS_BUCKET=$(terraform -chdir=../terraform output -raw backups_bucket)

# Only if terraform.tfvars set app_domain / letsencrypt_email - otherwise
# leave both unset and the app serves plain HTTP on the Elastic IP.
export APP_DOMAIN=chat.example.com
export LETSENCRYPT_EMAIL=you@example.com

ansible-playbook site.yml
```

It can take AWS Systems Manager a minute or two after `terraform apply` to register a brand-new instance as a managed node - if the first run can't find any hosts, that's almost always why. Give it a minute and try again before suspecting anything else.

## Checking it worked

```bash
terraform -chdir=terraform output app_url
```

To get a shell on the instance without ever having had an SSH key for it:

```bash
aws ssm start-session --target "$(terraform -chdir=terraform output -raw instance_id)"
```

`journalctl -u mini-chat -f` to watch it live; `systemctl status mini-chat-backup.timer` to confirm the nightly backup is scheduled; `curl -H "Authorization: Bearer $METRICS_TOKEN" localhost/api/metrics` (once a token exists in SSM) for the Prometheus exposition text this project's observability work already produces.

## Redeploying a new version

```bash
cd ansible
APP_REF=v1.2.0 ansible-playbook site.yml   # or a commit SHA, or a branch name
```

Re-running is always safe: the data volume is never reformatted once it has a filesystem on it, secrets are re-pulled fresh from SSM every time (so a rotated key takes effect on the next run, no redeploy-of-the-redeploy needed), and the app only restarts when something that matters - the build, the secrets, or the unit file - actually changed.

## Tearing it down

`terraform destroy` will refuse to touch the data volume - that's `prevent_destroy` in `terraform/data_volume.tf`, and it's deliberate. To actually remove it, delete that volume's data (an actual choice, not a slip during a destroy) and remove the lifecycle block in its own commit before destroying again.
