# Fill these in from `infra/bootstrap`'s outputs after that stack has been applied once:
#   terraform -chdir=infra/bootstrap output
#
# Until then this stack has no configured backend and `terraform init` uses local state,
# which is fine for `validate`/`plan` dry-runs but must not be used for a real apply.
#
# terraform {
#   backend "s3" {
#     bucket         = "devops-g5-tfstate-240462142849"
#     key            = "tillflow/main.tfstate"
#     region         = "eu-west-1"
#     dynamodb_table = "devops-g5-tflock"
#     encrypt        = true
#   }
# }
