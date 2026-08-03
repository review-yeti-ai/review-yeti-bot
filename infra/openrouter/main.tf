terraform {
  required_providers {
    openrouter = {
      source  = "registry.terraform.io/OpenRouterTeam/openrouter"
      version = "0.1.30"
    }
  }
}

provider "openrouter" {
  api_key = var.openrouter_management_key
}

resource "openrouter_workspace" "ct_review_fleet" {
  name        = var.workspace_name
  slug        = var.workspace_slug
  description = var.workspace_description
}

resource "openrouter_guardrail" "ct_review_fleet" {
  name           = var.guardrail_name
  description    = var.guardrail_description
  workspace_id   = openrouter_workspace.ct_review_fleet.id
  allowed_models = var.allowed_models
  limit_usd      = var.guardrail_limit_usd
  reset_interval = var.guardrail_reset_interval

  enable_free_model_training    = false
  enable_paid_model_training    = false
  enable_free_model_publication = false
}

resource "openrouter_api_key" "review_fleet_worker" {
  name         = var.completion_key_name
  limit        = var.completion_key_limit
  limit_reset  = var.completion_key_limit_reset
  workspace_id = openrouter_workspace.ct_review_fleet.id
}
