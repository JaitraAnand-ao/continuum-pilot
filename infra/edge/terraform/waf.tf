# ALB path patterns cannot contain %, so the refusal of percent-encoded paths under the
# Keycloak prefixes is enforced here. WAF inspects the URI path as the client sent it
# (text transformation NONE), so %2e%2e or %61dmin are blocked before the ALB forwards
# anything that Keycloak would decode into the master realm or the admin console.

resource "aws_wafv2_web_acl" "edge" {
  name        = "${var.name}-edge"
  description = "Refuses percent-encoded paths under the signin-reports realm and Keycloak resources"
  scope       = "REGIONAL"
  tags        = var.tags

  default_action {
    allow {}
  }

  rule {
    name     = "deny-encoded-keycloak-paths"
    priority = 1

    action {
      block {}
    }

    statement {
      regex_match_statement {
        regex_string = "^/(realms/signin-reports|resources)/.*%"

        field_to_match {
          uri_path {}
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-edge-deny-encoded"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-edge"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "edge" {
  resource_arn = aws_lb.edge.arn
  web_acl_arn  = aws_wafv2_web_acl.edge.arn
}
