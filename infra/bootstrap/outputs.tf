output "tfstate_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "tflock_table" {
  value = aws_dynamodb_table.tflock.name
}

output "tfstate_kms_key_arn" {
  value = aws_kms_key.tfstate.arn
}
