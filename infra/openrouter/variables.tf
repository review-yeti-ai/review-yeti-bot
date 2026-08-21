variable "openrouter_management_key" {
  description = "OpenRouter management key used only by Terraform/OpenTofu."
  type        = string
  sensitive   = true
}

variable "workspace_name" {
  description = "Display name for the review fleet workspace."
  type        = string
  default     = "CT Review Fleet"
}

variable "workspace_slug" {
  description = "Stable slug for the review fleet workspace."
  type        = string
  default     = "ct-review-fleet"
}

variable "workspace_description" {
  description = "Description for the review fleet workspace."
  type        = string
  default     = "PR review fleet - privacy-clean models only, no training"
}

variable "guardrail_name" {
  description = "Display name for the review fleet guardrail."
  type        = string
  default     = "CT Review Fleet Guardrail"
}

variable "guardrail_description" {
  description = "Description for the review fleet guardrail."
  type        = string
  default     = "Review fleet - privacy-clean models, no training"
}

variable "allowed_models" {
  description = "Model IDs allowed to receive review traffic. Re-audit provider privacy before changing this list."
  type        = list(string)
  default = [
    "openai/gpt-5.6-luna",
    "moonshotai/kimi-k2.6",
    "tencent/hy3",
    "z-ai/glm-5.1",
    "google/gemini-3.5-flash-lite",
  ]

  validation {
    condition     = length(var.allowed_models) > 0
    error_message = "allowed_models must contain at least one model ID."
  }
}

variable "guardrail_limit_usd" {
  description = "Monthly USD limit enforced by the review fleet guardrail."
  type        = number
  default     = 100

  validation {
    condition     = var.guardrail_limit_usd > 0
    error_message = "guardrail_limit_usd must be greater than zero."
  }
}

variable "guardrail_reset_interval" {
  description = "OpenRouter guardrail budget reset interval."
  type        = string
  default     = "monthly"
}

variable "completion_key_name" {
  description = "Name of the bounded completion key created on the review fleet workspace."
  type        = string
  default     = "review-fleet-worker"
}

variable "completion_key_limit" {
  description = "Monthly USD limit for the bounded completion key."
  type        = number
  default     = 100

  validation {
    condition     = var.completion_key_limit > 0
    error_message = "completion_key_limit must be greater than zero."
  }
}

variable "completion_key_limit_reset" {
  description = "OpenRouter completion-key budget reset interval."
  type        = string
  default     = "monthly"
}
