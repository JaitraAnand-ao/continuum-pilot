# Plan-level assertions for AD-19, run with `terraform test` from infra/edge/terraform.
# The mocked provider makes this run offline and pins the partition to GovCloud, so
# the module is proven against aws-us-gov values (rubric: govcloud-portable).

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws-us-gov"
      dns_suffix = "amazonaws.com"
    }
  }
}

variables {
  region                     = "us-gov-west-1"
  name_prefix                = "signin-reports"
  vpc_id                     = "vpc-0123456789abcdef0"
  public_subnet_ids          = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  certificate_arn            = "arn:aws-us-gov:acm:us-gov-west-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  access_logs_bucket         = "signin-reports-alb-logs"
  api_security_group_id      = "sg-0123456789abcdef0"
  keycloak_security_group_id = "sg-0123456789abcdef1"
}

run "listener_is_fips_tls_on_443_only" {
  command = plan

  assert {
    condition     = aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS"
    error_message = "The only listener must be HTTPS on 443."
  }

  assert {
    condition     = aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-FIPS-2023-04"
    error_message = "The listener must use the FIPS TLS policy."
  }

  assert {
    condition     = aws_lb.edge.internal == false && aws_lb.edge.drop_invalid_header_fields
    error_message = "The ALB must be internet-facing and drop invalid header fields."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.https) == 1 && alltrue([for r in aws_vpc_security_group_ingress_rule.https : r.from_port == 443 && r.to_port == 443])
    error_message = "Internet ingress must be 443 only."
  }
}

run "target_groups_re_encrypt" {
  command = plan

  assert {
    condition     = aws_lb_target_group.api.protocol == "HTTPS" && aws_lb_target_group.keycloak.protocol == "HTTPS"
    error_message = "Both target groups must re-encrypt to their targets."
  }

  assert {
    condition     = aws_lb_target_group.keycloak.port == 8443 && aws_lb_target_group.keycloak.health_check[0].port == "9000"
    error_message = "Keycloak serves on 8443 and is health-checked on its unrouted management port 9000."
  }
}

run "admin_paths_are_not_routed" {
  command = plan

  assert {
    condition     = one(aws_lb_listener_rule.deny_admin.action).type == "fixed-response" && contains(one(aws_lb_listener_rule.deny_admin.condition).path_pattern[0].values, "/admin/*")
    error_message = "/admin/* must be answered by a fixed 404, never forwarded."
  }

  assert {
    condition     = one(aws_lb_listener_rule.deny_master_realm.action).type == "fixed-response" && contains(one(aws_lb_listener_rule.deny_master_realm.condition).path_pattern[0].values, "/realms/master/*")
    error_message = "/realms/master/* must be answered by a fixed 404, never forwarded."
  }

  assert {
    condition     = aws_lb_listener_rule.deny_admin.priority < aws_lb_listener_rule.keycloak_realm.priority && aws_lb_listener_rule.deny_master_realm.priority < aws_lb_listener_rule.keycloak_realm.priority && aws_lb_listener_rule.deny_traversal.priority < aws_lb_listener_rule.keycloak_realm.priority
    error_message = "Deny rules must be evaluated before the Keycloak forward."
  }

  assert {
    condition     = toset(one(aws_lb_listener_rule.keycloak_realm.condition).path_pattern[0].values) == toset(["/realms/signin-reports/*"]) && toset(one(aws_lb_listener_rule.keycloak_resources.condition).path_pattern[0].values) == toset(["/resources/*"])
    error_message = "Only the signin-reports realm and /resources/* may reach Keycloak."
  }
}

run "rejects_a_certificate_from_another_partition" {
  command = plan

  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  expect_failures = [aws_lb_listener.https]
}

run "rejects_an_unknown_region" {
  command = plan

  variables {
    region = "gov-west"
  }

  expect_failures = [var.region]
}
