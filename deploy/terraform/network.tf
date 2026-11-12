# The default VPC, on purpose. This is one instance behind one public IP -
# a dedicated VPC module (private subnets, NAT gateway, an ALB in front)
# is the right call once there's more than one instance to isolate, and is
# pure cost and complexity before that. See deploy/README.md.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

locals {
  subnet_id = data.aws_subnets.default.ids[0]
}

data "aws_subnet" "chosen" {
  id = local.subnet_id
}

locals {
  # The EBS data volume and the instance have to live in the same AZ to
  # attach - deriving both from the same subnet is what keeps that true
  # automatically, instead of two variables that can silently drift apart.
  availability_zone = data.aws_subnet.chosen.availability_zone
}
