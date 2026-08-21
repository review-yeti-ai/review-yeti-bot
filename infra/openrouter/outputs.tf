output "workspace_id" {
  description = "OpenRouter ID of the managed review fleet workspace."
  value       = openrouter_workspace.ct_review_fleet.id
}

output "guardrail_id" {
  description = "OpenRouter ID of the managed review fleet guardrail."
  value       = openrouter_guardrail.ct_review_fleet.id
}

output "completion_key_hash" {
  description = "OpenRouter hash for guardrail assignment; this is not the raw key value."
  value       = openrouter_api_key.review_fleet_worker.hash
  sensitive   = true
}

output "completion_key_name" {
  description = "Name of the managed completion key."
  value       = openrouter_api_key.review_fleet_worker.name
}
