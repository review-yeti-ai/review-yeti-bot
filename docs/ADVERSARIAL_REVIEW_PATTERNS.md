# ⚔️ Adversarial AI Code Review Patterns & Architecture

## Executive Overview

Standard AI code review frameworks frequently suffer from **sycophancy** and **confirmation bias**. When prompted with standard evaluation instructions ("Review this code for quality"), Large Language Models tend to provide overly optimistic feedback, complimenting minor styling details while overlooking critical race conditions, state corruption, boundary flaws, and subtle security vulnerabilities.

**Adversarial AI Code Review** flips this paradigm by instituting explicit conflict and debate between specialized AI agents. By deploying **Hostile Personas** (Red Team) designed to actively exploit and invalidate code assumptions, balanced by a **Defender** (Blue Team) and an **Impartial Binding Arbiter**, the review pipeline achieves dramatically higher defect detection rates with near-zero false positive noise.

This document establishes the canonical architectural patterns, debate protocols, persona taxonomy, dual-model cross-examination mechanics, and data schemas for integrating adversarial review into `ct-review-bot`.

---

## 1. 🥊 Red Team vs Blue Team Debate Protocols

### 1.1 Multi-Phase Debate Workflow

Adversarial review follows a strict 4-stage pipeline that transitions from hypothesis generation to adversarial challenge, defense verification, and binding arbitration:

```text
  [ PR Diff Hunks ]
          │
          ▼
┌──────────────────┐
│  Phase 1: Attack │  Red-Team Hostile Personas (Saboteur, Security Auditor, Skeptic)
│   Generation     │  Generate hypothetical attack vectors, failure modes & exploits
└─────────┬────────┘
          │ (Attack Ledger: P0/P1/P2 claims)
          ▼
┌──────────────────┐
│ Phase 2: Defense │  Blue-Team Defender / Code Author Agent
│ & Cross-Exam     │  Validates, refutes, or demonstrates mitigations for each claim
└─────────┬────────┘
          │ (Refutation & Patch Matrix)
          ▼
┌──────────────────┐
│  Phase 3: Rebut  │  Moderator / Reconciler
│ & Reconciliation │  Filters invalid attacks, deduplicates findings & rates confidence
└─────────┬────────┘
          │ (Moderated Findings Ledger)
          ▼
┌──────────────────┐
│Phase 4: Binding  │  Binding Arbiter (Heterogeneous Model Family)
│   Arbitration    │  Issues binding verdict (SHIP / FIX_FIRST / BLOCK) + Rationale
└──────────────────┘
```

### 1.2 Protocol Execution Rules

1. **Fail-Closed Attack Phase**: Red-team personas assume the code is defective by default. They are mandated to construct at least one non-trivial attack scenario per changed file or output `UNATTACKABLE_EXPLICIT_PROOF`.
2. **Evidence-Based Refutation**: Blue-team defense cannot rely on assertion; refutations must cite explicit line numbers, guard clauses, type constraints, or invariant checks present in the codebase.
3. **Bounded Iteration**: Debate rounds are strictly limited to **Max 2 Turns** to prevent infinite agent argument loops and preserve token budgets.
4. **Deterministic Convergence**: If Red Team raises a P0/P1 vector and Blue Team cannot provide a line-referenced guard, the claim auto-promotes to a `FIX_FIRST` or `BLOCK` candidate for the Arbiter.

---

## 2. 👺 Hostile Persona Taxonomy

Adversarial review introduces dedicated hostile personas alongside standard domain charters (`builtin:security`, `builtin:correctness`).

| Persona ID | Mindset & Charter | Core Target Vulnerabilities / Defect Types | Target Prompt Strategy |
| :--- | :--- | :--- | :--- |
| **`saboteur`** | **Active Exploiter / Chaos Engineer**<br>Assumes runtime will experience maximum stress, latency, corrupted input, out-of-order concurrency, and resource starvation. | Race conditions, memory/goroutine leaks, unhandled promises, state desynchronization, deadlock potential, un-indexed queries. | *"Assume an adversary can control thread execution order and network timing. How can this code be forced into a deadlock or corrupt state?"* |
| **`security-auditor`** | **Zero-Trust Attacker**<br>Probes all boundaries for privilege escalation, token leakage, injection vectors, missing auth, and tenant isolation bypasses. | SQL/Command injection, auth bypass, tenant context leakage, hardcoded/insecure secrets, timing attacks, SSRF, missing input sanitization. | *"You are a black-hat security researcher reviewing this PR for zero-day vulnerabilities. Find any path to bypass authorization or extract cross-tenant data."* |
| **`skeptic`** | **Ruthless Code Critic**<br>Relentlessly questions assumptions, implicit contracts, missing edge-case tests, unhandled null/undefined values, and magic constants. | Unhandled error paths, missing boundary unit tests, incorrect type casts, hidden side-effects, breaking API schema changes, silent failures. | *"Challenge every assumption made by the developer in this PR. Identify every unhandled edge case where this code will fail in production."* |

---

## 3. ⚖️ Dual-Model Cross-Examination Mechanics

### 3.1 Asymmetric Cross-Model Matrix

Single-model review pipelines inherit the biases and safety filters of one specific model family. `ct-review-bot` uses OmniRoute to enforce multi-model cross-examination:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Dual-Model Cross-Examination Matrix                   │
├───────────────────┬────────────────────────────┬───────────────────────┤
│ Role              │ Model Family               │ Purpose / Advantage   │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ Red-Team Attacker │ Anthropic Claude Opus 4.8  │ Deep reasoning, state │
│                   │ / Claude Sonnet 5          │ tracing, adversarial  │
│                   │                            │ flaw discovery        │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ Blue-Team Defender│ OpenAI GPT-5.6 / Codex     │ Formal spec tracking, │
│                   │ / DeepSeek-V4 Pro          │ syntax validation,    │
│                   │                            │ guard verification    │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ Binding Arbiter   │ Synthetic GLM-5.2 /        │ Independent, low-bias │
│                   │ Grok-4.5 / Claude Opus     │ binding verdict gate  │
└───────────────────┴────────────────────────────┴───────────────────────┘
```

### 3.2 Sycophancy Suppression & Provenance Enforcement

1. **Heterogeneous Quorum Requirement**: Quorum cannot be satisfied by multiple instances of the same model family. The panel must include at least 2 distinct provider families (e.g. `claude` + `codex`).
2. **OmniRoute Provenance Guarantees**: `OmniRouteClient` validates `x-omniroute-provider` and `x-omniroute-model` headers. If OmniRoute attempts a silent fallback (e.g. substituting `claude` with `gpt`), the request fails closed immediately.
3. **Structured Nonce Fencing**: All prompts enforce fence markers (`CT_REVIEW_BEGIN:<nonce>` ... `CT_REVIEW_END:<nonce>`) to eliminate prompt injection attacks embedded inside diffs.

---

## 4. 📊 Attack-Defense Matrix Structural Schema

To bridge adversarial debate with the existing `panelEngine.ts` types (`PanelFinding`, `PanelResult`), adversarial reviews produce an **Attack-Defense Matrix**.

### 4.1 TypeScript Schema Definition

```typescript
export type AttackSeverity = 'P0' | 'P1' | 'P2';
export type DefenseStatus = 'REFUTED' | 'CONFIRMED_DEFECT' | 'MITIGATED' | 'PARTIAL';

export interface AttackVector {
  id: string;
  attackerPersona: 'saboteur' | 'security-auditor' | 'skeptic';
  severity: AttackSeverity;
  targetPath: string;
  targetLine: number;
  attackTitle: string;
  exploitScenario: string;
  impactDescription: string;
}

export interface DefenseClaim {
  attackId: string;
  status: DefenseStatus;
  refutationRationale: string;
  existingGuardLocation?: {
    path: string;
    line: number;
  };
  proposedFix?: string;
}

export interface ReconciledAttackFinding {
  attackVector: AttackVector;
  defenseClaim: DefenseClaim;
  finalSeverity: AttackSeverity;
  isActionableDefect: boolean;
  arbiterRecommendation: string;
}

export interface AttackDefenseMatrix {
  prHeadSha: string;
  totalAttacksGenerated: number;
  confirmedDefectsCount: number;
  refutedAttacksCount: number;
  findings: ReconciledAttackFinding[];
  verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
}
```

### 4.2 Integration with Existing `PanelResult`

The Attack-Defense Matrix maps directly into `PanelResult` as follows:
- Each Red-Team persona execution populates `PersonaLaneResult.findings`.
- The Moderator reconciles `AttackVector`s and `DefenseClaim`s into a `moderatedFindings` ledger.
- The Arbiter evaluates the reconciled matrix to yield `verdict` (`SHIP` | `FIX_FIRST` | `BLOCK`) and `rationale`.

---

## 5. 🎯 Open-Source Tool Synthesis & Insights

Research into `addyosmani/adverse`, `dementev-dev/adversarial-review`, `wan-huiyan/agent-review-panel`, `alecnielsen/adversarial-review`, and industry discussions yields four key findings integrated into this pattern:

1. **Role Division Prevents Sycophancy**: Seeding an agent with an explicit goal to *break* code forces the model out of its agreeable default mode.
2. **Defender Validation Reduces Noise**: Unfiltered adversarial bots generate excessive false positives. Adding a Blue Team / Moderator phase drops false positives by over 80%.
3. **Cross-Model Debate Uncovers Blind Spots**: Claude excels at complex logic/race condition attack framing, while GPT-5.6/DeepSeek excels at precise syntax and static constraint verification.
4. **Structured Nonce Fences Protect Against Direct Injection**: Adversarial review agents are primary targets for malicious diff injections (e.g. PR comments trying to trick the reviewer into approving). Nonce-fenced JSON responses neutralize this threat.
