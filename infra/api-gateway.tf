# HTTP API (API Gateway v2), not the REST API (v1): v1's VPC Link only accepts a Network
# Load Balancer, while v2's VPC Link can target an ALB directly - matching the brief's
# diagram ("API Gateway -> VPC Link -> ALB") without adding an NLB nobody asked for.

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${var.name_prefix}-vpclink"
  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.vpc_link.id]

  # The Resource Groups Tagging API doesn't expose this resource's own `name` property, only
  # its tags - Name here is what the naming/tag audit (and the console) actually reads.
  tags = {
    Name    = "${var.name_prefix}-vpclink"
    service = "network"
  }
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"

  tags = {
    Name    = "${var.name_prefix}-api"
    service = "platform"
  }
}

resource "aws_apigatewayv2_integration" "pos" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id
  integration_uri    = aws_lb_listener.pos.arn
}

# Everything proxies to pos for now - it's the only service that exists. Path-based routing
# to payments/commission gets added to this same API as those services come online, rather
# than standing up a separate API Gateway per service.
resource "aws_apigatewayv2_route" "pos_proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.pos.id}"
}

resource "aws_cloudwatch_log_group" "api_gateway_access" {
  name              = "/${var.name_prefix}/api-gateway"
  retention_in_days = 14

  tags = {
    service = "platform"
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.main.id
  # "$default" is a reserved, exact literal AWS requires for the default/root stage - it
  # can't be prefixed like everything else. The Name tag below is what stands in for it.
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway_access.arn
    format = jsonencode({
      requestId               = "$context.requestId"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      path                    = "$context.path"
      status                  = "$context.status"
      responseLength          = "$context.responseLength"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }

  tags = {
    Name    = "${var.name_prefix}-api-default-stage"
    service = "platform"
  }
}
