output "alb_arn" {
  description = "ARN of the edge ALB."
  value       = aws_lb.edge.arn
}

output "alb_dns_name" {
  description = "DNS name to alias the dashboard host to."
  value       = aws_lb.edge.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone of the ALB, for the Route 53 alias."
  value       = aws_lb.edge.zone_id
}

output "alb_security_group_id" {
  description = "Security group the api and Keycloak services admit traffic from."
  value       = aws_security_group.alb.id
}

output "api_target_group_arn" {
  description = "Target group the api ECS service registers with."
  value       = aws_lb_target_group.api.arn
}

output "keycloak_target_group_arn" {
  description = "Target group the Keycloak ECS service registers with."
  value       = aws_lb_target_group.keycloak.arn
}
