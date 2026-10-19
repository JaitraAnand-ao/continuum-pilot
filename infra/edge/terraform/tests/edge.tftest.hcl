# terraform test, from infra/edge/terraform. Plans the module against a mocked AWS
# provider with aws-us-gov values and asserts the AD-19 edge: one HTTPS listener on a FIPS
# policy, refusals ahead of the Keycloak forward, and no route to the admin surfaces.

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws-us-gov"
      dns_suffix = "amazonaws.com"
    }
  }
}

variables {
  vpc_id                     = "vpc-0123456789abcdef0"
  public_subnet_ids          = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  certificate_arn            = "arn:aws-us-gov:acm:us-gov-west-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  access_logs_bucket         = "signin-reports-edge-logs"
  api_security_group_id      = "sg-0aaaaaaaaaaaaaaaa"
  keycloak_security_group_id = "sg-0bbbbbbbbbbbbbbbb"
}

run "listener_is_fips_https_on_443_only" {
  command = plan

  assert {
    condition     = aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS"
    error_message = "The only listener must be HTTPS on 443."
  }

  assert {
    condition     = can(regex("FIPS", aws_lb_listener.https.ssl_policy))
    error_message = "The listener must use a FIPS TLS policy."
  }

  assert {
    condition     = aws_lb.edge.internal == false && aws_lb.edge.drop_invalid_header_fields
    error_message = "The ALB must be internet-facing and drop invalid header fields."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.https_ipv4.from_port == 443 && aws_vpc_security_group_ingress_rule.https_ipv4.to_port == 443
    error_message = "Internet ingress must be 443 only."
  }
}

run "targets_are_re_encrypted" {
  command = plan

  assert {
    condition     = aws_lb_target_group.api.protocol == "HTTPS" && aws_lb_target_group.keycloak.protocol == "HTTPS"
    error_message = "Both target groups must re-encrypt with HTTPS."
  }

  assert {
    condition     = aws_lb_target_group.keycloak.health_check[0].path == "/health/ready"
    error_message = "Keycloak readiness is checked on the management interface."
  }
}

run "admin_paths_are_not_routed" {
  command = plan

  assert {
    condition     = alltrue([for p in ["/admin/*", "/realms/master/*", "/resources/*/admin/*"] : contains(tolist(aws_lb_listener_rule.deny_admin.condition)[0].path_pattern[0].values, p)])
    error_message = "The admin console, admin API and master realm must be refused."
  }

  assert {
    condition     = tolist(aws_lb_listener_rule.deny_admin.action)[0].fixed_response[0].status_code == "404"
    error_message = "Admin paths are answered 404 at the edge."
  }

  assert {
    condition     = aws_lb_listener_rule.deny_admin.priority < aws_lb_listener_rule.keycloak.priority && aws_lb_listener_rule.deny_encoded.priority < aws_lb_listener_rule.keycloak.priority
    error_message = "Refusals must be evaluated before the Keycloak forward."
  }

  assert {
    condition     = toset(tolist(aws_lb_listener_rule.keycloak.condition)[0].path_pattern[0].values) == toset(["/realms/signin-reports/*", "/resources/*"])
    error_message = "Only the signin-reports realm and Keycloak resources are forwarded to Keycloak."
  }
}

run "rejects_a_commercial_certificate_in_govcloud" {
  command = plan

  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  expect_failures = [aws_lb_listener.https]
}
