output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.pos.repository_url
}

output "payments_ecr_repository_url" {
  value = aws_ecr_repository.payments.repository_url
}

output "commission_ecr_repository_url" {
  value = aws_ecr_repository.commission.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.pos.name
}

output "payments_ecs_service_name" {
  value = aws_ecs_service.payments.name
}

output "commission_ecs_service_name" {
  value = aws_ecs_service.commission.name
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "ci_deploy_role_arn" {
  value = aws_iam_role.ci_deploy.arn
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "db_address" {
  value = aws_db_instance.main.address
}

output "db_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}
