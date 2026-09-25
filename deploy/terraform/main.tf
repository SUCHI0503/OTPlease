# One small server for staging, plus a private bucket for database backups.
#   terraform init && terraform plan -var-file=staging.tfvars     (review the plan)
#   terraform apply -var-file=staging.tfvars                       (creates billable resources)
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "otplease", Environment = var.environment } }
}

variable "region" {
  type        = string
  description = "AWS region, e.g. ap-south-1 (Mumbai)"
}
variable "environment" {
  type    = string
  default = "staging"
}
variable "domain" {
  type        = string
  description = "Base domain for this environment, e.g. staging.example.com. Uses api.<domain>, app.<domain>, demo.<domain>"
}
variable "hosted_zone_id" {
  type        = string
  default     = ""
  description = "Route 53 hosted zone that holds the domain. Leave empty to create the DNS records yourself elsewhere."
}
variable "ssh_public_key" {
  type        = string
  description = "Contents of your public key (~/.ssh/id_ed25519.pub)"
}
variable "ssh_allowed_cidr" {
  type        = string
  description = "Who may SSH in, as a CIDR. Use your own address: 203.0.113.7/32. Never 0.0.0.0/0."
  validation {
    condition     = var.ssh_allowed_cidr != "0.0.0.0/0"
    error_message = "ssh_allowed_cidr must not be open to the whole internet."
  }
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
variable "disk_gb" {
  type    = number
  default = 30
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_caller_identity" "me" {}

resource "aws_key_pair" "deploy" {
  key_name   = "otplease-${var.environment}"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "web" {
  name        = "otplease-${var.environment}-web"
  description = "HTTP, HTTPS for everyone; SSH only from one address"

  ingress {
    description = "HTTP (redirects to HTTPS, certificate checks)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH from the operator only"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Backups: private, encrypted, versioned, expiring after 35 days
resource "aws_s3_bucket" "backups" {
  bucket = "otplease-${var.environment}-backups-${data.aws_caller_identity.me.account_id}"
}
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    expiration { days = 35 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
}

# The server may write backups to that one bucket and nothing else
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
data "aws_iam_policy_document" "backup_access" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
  }
}
resource "aws_iam_role" "server" {
  name               = "otplease-${var.environment}-server"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
resource "aws_iam_role_policy" "backup_access" {
  name   = "backups"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.backup_access.json
}
resource "aws_iam_instance_profile" "server" {
  name = "otplease-${var.environment}-server"
  role = aws_iam_role.server.name
}

resource "aws_instance" "server" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.deploy.key_name
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.server.name

  root_block_device {
    volume_size = var.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required" # blocks the metadata-service theft that leaks role credentials
  }
  tags = { Name = "otplease-${var.environment}" }
}

resource "aws_eip" "server" {
  instance = aws_instance.server.id
  domain   = "vpc"
}

resource "aws_route53_record" "hosts" {
  for_each = var.hosted_zone_id == "" ? toset([]) : toset(["api", "app", "demo"])
  zone_id  = var.hosted_zone_id
  name     = "${each.key}.${var.domain}"
  type     = "A"
  ttl      = 300
  records  = [aws_eip.server.public_ip]
}

output "server_ip" { value = aws_eip.server.public_ip }
output "backup_bucket" { value = aws_s3_bucket.backups.bucket }
output "dns_records_needed" {
  value = var.hosted_zone_id == "" ? "Create A records api/app/demo.${var.domain} -> ${aws_eip.server.public_ip}" : "created in Route 53"
}
