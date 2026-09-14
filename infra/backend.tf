# Fill these in from `infra/bootstrap`'s outputs after that stack has been applied once:
#   terraform -chdir=infra/bootstrap output
#
# Until then this stack has no configured backend and `terraform init` uses local state,
# which is fine for `validate`/`plan` dry-runs but must not be used for a real apply.
#
# terraform {
#   backend "s3" {
#     bucket         = "devops-g<N>-tfstate-<account-id>"
#     key            = "tillflow/main.tfstate"
#     region         = "af-south-1"
#     dynamodb_table = "devops-g<N>-tflock"
#     encrypt        = true
#   }
# }
