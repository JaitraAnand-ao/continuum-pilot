# CMP-10 — the production edge (AD-19). One internet-facing ALB, one HTTPS listener on 443
# with a FIPS TLS policy, re-encrypting to the api and Keycloak. The only Keycloak paths the
# internet can reach are the signin-reports realm and its static resources; the admin
# console, the admin REST API and the master realm are refused before any forward rule.

data "aws_partition" "current" {}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Signin-reports ALB: HTTPS 443 from the internet, egress to api and Keycloak only"
  vpc_id      = var.vpc_id
  tags        = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "https_ipv4" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Re-encrypted traffic to the api"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = var.api_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "keycloak" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Re-encrypted traffic to Keycloak"
  ip_protocol                  = "tcp"
  from_port                    = var.keycloak_port
  to_port                      = var.keycloak_port
  referenced_security_group_id = var.keycloak_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "keycloak_health" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Health checks to the Keycloak management interface"
  ip_protocol                  = "tcp"
  from_port                    = var.keycloak_management_port
  to_port                      = var.keycloak_management_port
  referenced_security_group_id = var.keycloak_security_group_id
}

resource "aws_lb" "edge" {
  name                       = "${var.name}-edge"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = true
  idle_timeout               = 60
  tags                       = var.tags

  access_logs {
    bucket  = var.access_logs_bucket
    prefix  = "edge"
    enabled = true
  }
}
