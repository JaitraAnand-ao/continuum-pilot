resource "aws_lb_target_group" "api" {
  name_prefix          = "api-"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  protocol             = "HTTPS"
  protocol_version     = "HTTP1"
  port                 = var.api_port
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    protocol            = "HTTPS"
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "keycloak" {
  name_prefix          = "kc-"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  protocol             = "HTTPS"
  protocol_version     = "HTTP1"
  port                 = var.keycloak_port
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    protocol            = "HTTPS"
    port                = var.keycloak_management_port
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  stickiness {
    type    = "lb_cookie"
    enabled = false
  }

  lifecycle {
    create_before_destroy = true
  }
}
