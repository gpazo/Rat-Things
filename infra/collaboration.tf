variable "oidc_providers" {
  description = "Trusted OIDC access-token providers for shared Agents and Sessions; see docs/collaboration.md."
  type = list(object({
    id                    = string
    issuer                = string
    jwksUri               = string
    clientId              = string
    audience              = optional(string)
    profile               = optional(string, "jwt_access")
    authorizationEndpoint = string
    tokenEndpoint         = string
    redirectUri           = string
    scopes                = optional(list(string), ["openid", "profile"])
    requiredScopes        = optional(list(string), [])
    apiScopes             = optional(list(string))
  }))
  default = []
}

output "shared_agents_api_base_url" {
  value = module.agent_runner.shared_agents_api_base_url
}
