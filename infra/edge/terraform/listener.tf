resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 443
  protocol          = "HTTPS"
  # Restricted FIPS policy: TLS 1.3 and 1.2, forward-secret AES-GCM suites only.
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-FIPS-2023-04"
  certificate_arn   = var.certificate_arn
  tags              = var.tags

  # Everything that is not the realm or its resources belongs to the api (SPA and BFF).
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  lifecycle {
    precondition {
      condition     = startswith(var.certificate_arn, "arn:${data.aws_partition.current.partition}:acm:")
      error_message = "certificate_arn must be an ACM certificate in the current partition."
    }
  }
}

# Refusals come first (priorities 1–9) so no later forward can reach what they cover.

# Traversal and encoded paths: ALB matches the raw path, Keycloak decodes and resolves it,
# so /realms/signin-reports/../master or %61dmin would otherwise slip past the rules below.
resource "aws_lb_listener_rule" "deny_encoded" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1
  tags         = var.tags

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not found"
    }
  }

  condition {
    path_pattern {
      values = ["*..*", "/realms/signin-reports/*%*", "/resources/*%*"]
    }
  }
}

resource "aws_lb_listener_rule" "deny_admin" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 2
  tags         = var.tags

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not found"
    }
  }

  condition {
    path_pattern {
      values = ["/admin", "/admin/*", "/realms/master", "/realms/master/*", "/resources/*/admin/*"]
    }
  }
}

resource "aws_lb_listener_rule" "keycloak" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.keycloak.arn
  }

  condition {
    path_pattern {
      values = ["/realms/signin-reports/*", "/resources/*"]
    }
  }
}
