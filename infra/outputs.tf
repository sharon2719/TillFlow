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

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.pos.name
}

output "ci_deploy_role_arn" {
  value = aws_iam_role.ci_deploy.arn
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}
