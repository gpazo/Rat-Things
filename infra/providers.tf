provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

provider "awscc" {
  region  = var.aws_region
  profile = var.aws_profile
}
