terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Local state for a single small instance is fine to start with. The
  # moment more than one person applies this, switch to an S3 backend with
  # DynamoDB locking - uncomment and fill in once that bucket exists:
  #
  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "mini-chat/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}
