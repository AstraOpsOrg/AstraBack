variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "astraops-eks"
}

variable "access_principals" {
  description = "List of IAM principal ARNs to grant EKS cluster access via Access Entries"
  type        = list(string)
  default     = []
}

variable "execution_role_arn" {
  description = "IAM Role ARN used by backend to run kubectl; will be mapped to system:masters via aws-auth"
  type        = string
  default     = ""
}


