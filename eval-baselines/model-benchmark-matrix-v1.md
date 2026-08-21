# Model Comparative Evaluation & Benchmark Report

**Generated**: 2026-08-20T17:15:12.973Z
**Evaluated Models**: deepseek/deepseek-v4-flash-0731:high, openrouter/5.6-luna-high, qwen/qwen-3.8-27b:high, google/gemini-3.7-flash:high
**Total Scenarios**: 20

## 1. Executive Summary & Comparative Matrix

| Model | Verdict Acc (%) | Precision | Recall | F1 Score | Avg SNR (dB) | TTFT (ms) | Turn Depth | Total Tokens | Cost (USD) | Cost Eff (TP/$) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `deepseek/deepseek-v4-flash-0731:high` | **100.0%** | 1.000 | 1.000 | **1.000** | 11.7 dB | 105 ms | 1.2 | 15,756 | $0.0025 | 7200.0 |
| `openrouter/5.6-luna-high` | **100.0%** | 1.000 | 1.000 | **1.000** | 11.7 dB | 135 ms | 1.2 | 16,496 | $0.0412 | 436.9 |
| `qwen/qwen-3.8-27b:high` | **90.0%** | 1.000 | 0.889 | **0.941** | 9.7 dB | 140 ms | 1.2 | 16,436 | $0.0067 | 2388.1 |
| `google/gemini-3.7-flash:high` | **100.0%** | 1.000 | 1.000 | **1.000** | 11.7 dB | 115 ms | 1.2 | 15,756 | $0.0032 | 5625.0 |

## 2. Key Comparative Dimensions

1. **Signal-to-Noise Ratio (SNR)**: Measures genuine defect discovery against false positives/hallucinations.
2. **Time-to-First-Token (TTFT)**: Latency from initial request dispatch to first streaming token chunk.
3. **Total Tokens In / Out**: Input prompt overhead and output completion verbosity.
4. **Findings Accuracy, Precision & Recall**: Ground-truth defect identification ($TP$), non-defect noise ($FP$), and missed defects ($FN$).
5. **Investigation Turn Depth**: Average multi-turn tool calling cycles per review.
6. **Cost Efficiency**: Verified True Positive findings discovered per USD spent.

## 3. Scenario-by-Scenario Detailed Breakdown

| Scenario ID | Model | Category | Expected | Actual | Match | TP | FP | FN | F1 | SNR | TTFT (ms) | Cost ($) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `sec-multi-tenant-isolation` | `deepseek/deepseek-v4-flash-0731:high` | security | BLOCK | BLOCK | ✅ | 2 | 0 | 0 | 1.00 | 2.0 | 105 | $0.0002 |
| `sec-committed-secret` | `deepseek/deepseek-v4-flash-0731:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `sec-sql-injection` | `deepseek/deepseek-v4-flash-0731:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `perf-n-plus-one-query` | `deepseek/deepseek-v4-flash-0731:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `perf-blocking-sync-io` | `deepseek/deepseek-v4-flash-0731:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `perf-unbounded-memory-cache` | `deepseek/deepseek-v4-flash-0731:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `arch-layering-violation` | `deepseek/deepseek-v4-flash-0731:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `arch-circular-dependency` | `deepseek/deepseek-v4-flash-0731:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `arch-breaking-api-signature` | `deepseek/deepseek-v4-flash-0731:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `test-uncovered-error-branch` | `deepseek/deepseek-v4-flash-0731:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `test-active-only-marker` | `deepseek/deepseek-v4-flash-0731:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `test-brittle-mock-assertions` | `deepseek/deepseek-v4-flash-0731:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `db-destructive-drop-column` | `deepseek/deepseek-v4-flash-0731:high` | database | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `db-non-concurrent-index` | `deepseek/deepseek-v4-flash-0731:high` | database | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `dep-wildcard-version` | `deepseek/deepseek-v4-flash-0731:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `dep-lockfile-desync` | `deepseek/deepseek-v4-flash-0731:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0001 |
| `multifile-auth-refactor` | `deepseek/deepseek-v4-flash-0731:high` | multi_file | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 105 | $0.0002 |
| `multiturn-author-rejected-nit` | `deepseek/deepseek-v4-flash-0731:high` | multi_turn | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 105 | $0.0001 |
| `evidence-deterministic-tool-verification` | `deepseek/deepseek-v4-flash-0731:high` | evidence | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 105 | $0.0001 |
| `clean-multi-feature-ship` | `deepseek/deepseek-v4-flash-0731:high` | multi_file | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 105 | $0.0001 |
| `sec-multi-tenant-isolation` | `openai/gpt-5.6-luna` | security | BLOCK | BLOCK | ✅ | 2 | 0 | 0 | 1.00 | 2.0 | 135 | $0.0030 |
| `sec-committed-secret` | `openai/gpt-5.6-luna` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0019 |
| `sec-sql-injection` | `openai/gpt-5.6-luna` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0020 |
| `perf-n-plus-one-query` | `openai/gpt-5.6-luna` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0021 |
| `perf-blocking-sync-io` | `openai/gpt-5.6-luna` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0021 |
| `perf-unbounded-memory-cache` | `openai/gpt-5.6-luna` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0019 |
| `arch-layering-violation` | `openai/gpt-5.6-luna` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0020 |
| `arch-circular-dependency` | `openai/gpt-5.6-luna` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0020 |
| `arch-breaking-api-signature` | `openai/gpt-5.6-luna` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0019 |
| `test-uncovered-error-branch` | `openai/gpt-5.6-luna` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0023 |
| `test-active-only-marker` | `openai/gpt-5.6-luna` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0020 |
| `test-brittle-mock-assertions` | `openai/gpt-5.6-luna` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0020 |
| `db-destructive-drop-column` | `openai/gpt-5.6-luna` | database | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0018 |
| `db-non-concurrent-index` | `openai/gpt-5.6-luna` | database | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0018 |
| `dep-wildcard-version` | `openai/gpt-5.6-luna` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0018 |
| `dep-lockfile-desync` | `openai/gpt-5.6-luna` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0018 |
| `multifile-auth-refactor` | `openai/gpt-5.6-luna` | multi_file | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 135 | $0.0028 |
| `multiturn-author-rejected-nit` | `openai/gpt-5.6-luna` | multi_turn | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 135 | $0.0018 |
| `evidence-deterministic-tool-verification` | `openai/gpt-5.6-luna` | evidence | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 135 | $0.0021 |
| `clean-multi-feature-ship` | `openai/gpt-5.6-luna` | multi_file | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 135 | $0.0021 |
| `sec-multi-tenant-isolation` | `qwen/qwen-3.8-27b:high` | security | BLOCK | BLOCK | ✅ | 2 | 0 | 0 | 1.00 | 2.0 | 140 | $0.0005 |
| `sec-committed-secret` | `qwen/qwen-3.8-27b:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `sec-sql-injection` | `qwen/qwen-3.8-27b:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `perf-n-plus-one-query` | `qwen/qwen-3.8-27b:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `perf-blocking-sync-io` | `qwen/qwen-3.8-27b:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `perf-unbounded-memory-cache` | `qwen/qwen-3.8-27b:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `arch-layering-violation` | `qwen/qwen-3.8-27b:high` | architecture | FIX_FIRST | SHIP | ❌ | 0 | 0 | 1 | 0.00 | 0.0 | 140 | $0.0003 |
| `arch-circular-dependency` | `qwen/qwen-3.8-27b:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `arch-breaking-api-signature` | `qwen/qwen-3.8-27b:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `test-uncovered-error-branch` | `qwen/qwen-3.8-27b:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0004 |
| `test-active-only-marker` | `qwen/qwen-3.8-27b:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `test-brittle-mock-assertions` | `qwen/qwen-3.8-27b:high` | testing | FIX_FIRST | SHIP | ❌ | 0 | 0 | 1 | 0.00 | 0.0 | 140 | $0.0003 |
| `db-destructive-drop-column` | `qwen/qwen-3.8-27b:high` | database | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `db-non-concurrent-index` | `qwen/qwen-3.8-27b:high` | database | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `dep-wildcard-version` | `qwen/qwen-3.8-27b:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `dep-lockfile-desync` | `qwen/qwen-3.8-27b:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0003 |
| `multifile-auth-refactor` | `qwen/qwen-3.8-27b:high` | multi_file | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 140 | $0.0005 |
| `multiturn-author-rejected-nit` | `qwen/qwen-3.8-27b:high` | multi_turn | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 140 | $0.0003 |
| `evidence-deterministic-tool-verification` | `qwen/qwen-3.8-27b:high` | evidence | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 140 | $0.0003 |
| `clean-multi-feature-ship` | `qwen/qwen-3.8-27b:high` | multi_file | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 140 | $0.0003 |
| `sec-multi-tenant-isolation` | `google/gemini-3.7-flash:high` | security | BLOCK | BLOCK | ✅ | 2 | 0 | 0 | 1.00 | 2.0 | 115 | $0.0002 |
| `sec-committed-secret` | `google/gemini-3.7-flash:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `sec-sql-injection` | `google/gemini-3.7-flash:high` | security | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `perf-n-plus-one-query` | `google/gemini-3.7-flash:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `perf-blocking-sync-io` | `google/gemini-3.7-flash:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `perf-unbounded-memory-cache` | `google/gemini-3.7-flash:high` | performance | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `arch-layering-violation` | `google/gemini-3.7-flash:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `arch-circular-dependency` | `google/gemini-3.7-flash:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `arch-breaking-api-signature` | `google/gemini-3.7-flash:high` | architecture | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `test-uncovered-error-branch` | `google/gemini-3.7-flash:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `test-active-only-marker` | `google/gemini-3.7-flash:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `test-brittle-mock-assertions` | `google/gemini-3.7-flash:high` | testing | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `db-destructive-drop-column` | `google/gemini-3.7-flash:high` | database | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0001 |
| `db-non-concurrent-index` | `google/gemini-3.7-flash:high` | database | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0001 |
| `dep-wildcard-version` | `google/gemini-3.7-flash:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0001 |
| `dep-lockfile-desync` | `google/gemini-3.7-flash:high` | dependencies | FIX_FIRST | FIX_FIRST | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0001 |
| `multifile-auth-refactor` | `google/gemini-3.7-flash:high` | multi_file | BLOCK | BLOCK | ✅ | 1 | 0 | 0 | 1.00 | 1.0 | 115 | $0.0002 |
| `multiturn-author-rejected-nit` | `google/gemini-3.7-flash:high` | multi_turn | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 115 | $0.0001 |
| `evidence-deterministic-tool-verification` | `google/gemini-3.7-flash:high` | evidence | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 115 | $0.0002 |
| `clean-multi-feature-ship` | `google/gemini-3.7-flash:high` | multi_file | SHIP | SHIP | ✅ | 0 | 0 | 0 | 1.00 | 0.0 | 115 | $0.0002 |
