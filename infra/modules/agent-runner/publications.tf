locals {
  publication_delivery_enabled = var.enable_publication_delivery
  publication_domain = var.publication_base_domain == null ? "" : trimsuffix(
    lower(trimspace(var.publication_base_domain)),
    ".",
  )
  publication_public_key_pem = var.publication_public_key_pem == null ? "" : "${trimspace(var.publication_public_key_pem)}\n"
}

check "publication_delivery_configuration" {
  assert {
    condition = !local.publication_delivery_enabled || (
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", local.publication_domain)) &&
      try(length(trimspace(var.publication_certificate_arn)) > 0, false) &&
      try(length(trimspace(var.publication_public_key_pem)) > 0, false) &&
      try(length(trimspace(var.publication_private_key_secret_arn)) > 0, false)
    )
    error_message = "Publication delivery requires a valid base domain, wildcard ACM certificate, CloudFront public key, and matching private-key secret ARN."
  }
}

data "aws_cloudfront_cache_policy" "publication_content" {
  count = local.publication_delivery_enabled ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "publication_redemption" {
  count = local.publication_delivery_enabled ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "publication_redemption" {
  count = local.publication_delivery_enabled ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_public_key" "publications" {
  count = local.publication_delivery_enabled ? 1 : 0

  name        = "${local.name}-publications-${substr(sha256(coalesce(var.publication_public_key_pem, "")), 0, 12)}"
  comment     = "Signed-cookie verification key for ${local.name} publications"
  encoded_key = local.publication_public_key_pem

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudfront_key_group" "publications" {
  count = local.publication_delivery_enabled ? 1 : 0

  name    = "${local.name}-publications"
  comment = "Trusted signers for ${local.name} publications"
  items   = [aws_cloudfront_public_key.publications[0].id]
}

resource "aws_cloudfront_origin_access_control" "publications" {
  count = local.publication_delivery_enabled ? 1 : 0

  name                              = "${local.name}-publications"
  description                       = "Private S3 publication origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "publication_router" {
  count = local.publication_delivery_enabled ? 1 : 0

  name    = "${local.name}-publication-router"
  runtime = "cloudfront-js-2.0"
  comment = "Map isolated publication hosts to owner-scoped S3 prefixes"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      var host = request.headers.host.value.toLowerCase().split(':')[0];
      var label = host.split('.')[0];
      var match = label.match(/^([a-f0-9]{24})-([a-f0-9]{32})$/);
      if (!match) {
        return {
          statusCode: 404,
          statusDescription: 'Not Found',
          headers: { 'cache-control': { value: 'private, no-store' } }
        };
      }
      var uri = request.uri;
      var decoded;
      try {
        decoded = decodeURIComponent(uri);
      } catch (error) {
        return { statusCode: 400, statusDescription: 'Bad Request' };
      }
      var segments = decoded.split('/');
      if (segments.indexOf('..') !== -1) {
        return { statusCode: 400, statusDescription: 'Bad Request' };
      }
      if (decoded === '/_rat' || decoded.indexOf('/_rat/') === 0) {
        return { statusCode: 404, statusDescription: 'Not Found' };
      }
      if (uri.charAt(uri.length - 1) === '/') uri += 'index.html';
      request.uri = '/owners/' + match[2] + '/publications/' + match[1] + uri;
      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_response_headers_policy" "publications" {
  count = local.publication_delivery_enabled ? 1 : 0

  name    = "${local.name}-publications"
  comment = "Browser isolation and private client caching for agent publications"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      override = true
      value    = "private, no-store"
    }
    items {
      header   = "Permissions-Policy"
      override = true
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    }
  }

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
      preload                    = true
    }
  }
}

resource "aws_cloudfront_distribution" "publications" {
  count = local.publication_delivery_enabled ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name} isolated agent publications"
  aliases         = ["*.${local.publication_domain}"]
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.artifacts.bucket_regional_domain_name
    origin_id                = "publication-artifacts"
    origin_access_control_id = aws_cloudfront_origin_access_control.publications[0].id
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.this.api_endpoint, "https://", "")
    origin_id   = "publication-redemption"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "publication-artifacts"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = data.aws_cloudfront_cache_policy.publication_content[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.publications[0].id
    trusted_key_groups         = [aws_cloudfront_key_group.publications[0].id]
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.publication_router[0].arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "__share/*"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "publication-redemption"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = data.aws_cloudfront_cache_policy.publication_redemption[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.publication_redemption[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.publications[0].id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.publication_certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = merge(local.tags, { Component = "publication-delivery" })
}

resource "aws_route53_record" "publication_ipv4" {
  count = local.publication_delivery_enabled && var.publication_route53_zone_id != null ? 1 : 0

  zone_id = var.publication_route53_zone_id
  name    = "*.${local.publication_domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.publications[0].domain_name
    zone_id                = aws_cloudfront_distribution.publications[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "publication_ipv6" {
  count = local.publication_delivery_enabled && var.publication_route53_zone_id != null ? 1 : 0

  zone_id = var.publication_route53_zone_id
  name    = "*.${local.publication_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.publications[0].domain_name
    zone_id                = aws_cloudfront_distribution.publications[0].hosted_zone_id
    evaluate_target_health = false
  }
}
