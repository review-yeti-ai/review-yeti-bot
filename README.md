# 🤖 ct-review-bot — Enterprise GitHub Review Platform & Memory Engine

[![CI/CD Pipeline](https://github.com/calltelemetry/ct-review-bot/actions/workflows/ci-cd.yaml/badge.svg)](https://github.com/calltelemetry/ct-review-bot/actions/workflows/ci-cd.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Kubernetes](https://img.shields.io/badge/K8s-DigitalOcean%20DOKS-326CE5.svg)](https://digitalocean.com)
[![Blacksmith CI](https://img.shields.io/badge/CI%2FCD-Blacksmith-black.svg)](https://blacksmith.sh)

`ct-review-bot` is an enterprise-grade, quorum-based GitHub Review Platform competing directly with CodeRabbit and Greptile. It combines multi-LLM review panels, an **In-House $0-Cost AST Codebase Indexer**, **Context7 MCP integration via Doppler**, **Persistent PR Memory**, and **Automated Mermaid Architecture Visualizers**.

```text
  ____ _____   ____  _______   _____ _______        __  ____   ____ _____ 
 / ___|_   _| |  _ \\| ____\\ \\ / /_ _| ____\\ \\      / / | __ ) / ___|_   _|
| |     | |   | |_) |  _|  \\ V / | ||  _|  \\ \\ /\\ / /  |  _ \\| |     | |  
| |___  | |   |  _ <| |___  | |  | || |___  \\ V  V /   | |_) | |___  | |  
 \\____| |_|   |_| \\_\\_____| |_| |___|_____|  \\_/\\_/    |____/ \\____| |_|  
```

---

## 🌟 Key Features

### 1. CodeRabbit-Grade PR Summaries & Diagrams
- 📋 **Executive Summaries & Walkthroughs**: High-level overviews, bulleted walkthroughs, and module changeset tables.
- 📐 **Automated Mermaid Visualizer**: Automatically generates `mermaid` sequence and flowchart diagrams for complex PR diffs.
- 🎯 **Confidence Scores & Ranked Fixes**: Every finding includes 0-100% confidence ratings, recommendations, 1-click GitHub apply suggestion blocks (````suggestion ... ````), and up to 2 ranked potential fixes (`Option 1` vs `Option 2`).

### 2. Interactive PR Chat (`@ct-review`)
- 💬 **Conversational Threading**: Responds directly to inline comment replies and PR mentions.
- ⚡ **Command Suite**:
  - `@ct-review review`: Trigger an on-demand quorum review.
  - `@ct-review ask <question>`: Ask questions about the PR or codebase.
  - `@ct-review refactor`: Request code refactoring suggestions.
  - `@ct-review explain`: Request detailed explanations of complex logic.
  - `@ct-review summarize`: Generate a fresh PR executive summary.

### 3. In-House Code Indexer (`ct-indexer`) — $0 SaaS Fees
- 🧠 **Tree-sitter AST Symbol Graph**: Parses classes, functions, interfaces, imports, and caller/callee graphs across TypeScript, JavaScript, and Python.
- ⚡ **Ultra-Fast Indexing**: **10,500 lines of code indexed in 272ms** at **$0 indexing subscription cost** (saving $600/mo vs third-party SaaS indexers).
- 🔍 **Vector Embedder**: 384-dimensional dense vector embeddings with SQLite / LanceDB storage for semantic code search.

### 4. Context7 MCP Fleet Integration & Doppler Secrets
- 🔐 **Doppler Secret Routing**: Dynamic 4-tier secret manager retrieving `CONTEXT7_API_KEY` securely from Doppler API / CLI.
- 📚 **Public Docs Lookup**: Queries Context7 MCP server for external library and framework documentation with in-memory TTL caching.

### 5. Persistent PR Memory & Nit Suppression
- 📈 **PR Learning Graph (`.ct-memory/` / SQLite)**: Stores past PR review outcomes, resolved nit patterns, and repo ADR guidelines.
- 🚫 **Duplicate Nit Suppression**: Eliminates duplicate review flags across PR pushes with **100% precision**.

### 6. Blacksmith CI/CD & DOKS Rolling Deployment
- ⚡ **Blacksmith Runners**: GitHub Actions (`ci-cd.yaml`, `release-semver.yaml`) with Docker Buildx `type=gha` layer caching.
- ☸️ **DigitalOcean Kubernetes**: Multi-arch `linux/amd64` builds pushed to DigitalOcean Container Registry (DOCR) with zero-downtime rolling updates to `cluster-ny1`.

---

## 🏗️ Platform Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Developer
    participant GitHub as GitHub Webhook
    participant Bot as ct-review-bot (DOKS)
    participant Memory as In-House ct-indexer
    participant Quorum as Quorum Panel (Sonnet 5 / GPT 5.6 Sol)
    
    Developer->>GitHub: Git Push (PR #1438)
    GitHub->>Bot: POST /webhook (HMAC Verified)
    Bot->>Memory: Query Symbol Graph & Memory (/api/memory/query)
    Memory-->>Bot: Return AST Callers & Resolved Nit History
    Bot->>Quorum: Dispatch Personas with AST Context
    Quorum-->>Bot: Return Findings + Mermaid Diagrams
    Bot->>GitHub: POST Review Verdict (REQUEST_CHANGES + Ranked Fixes)
```

---

## 🚀 Getting Started Guide

### Prerequisites
- Node.js >= 20.x
- Docker & `doctl` (for Kubernetes deployment)
- GitHub App installed on target organization
- Doppler CLI / Token (optional, for Context7 MCP secrets)

---

### Step 1: Install Dependencies & Run Tests
```bash
# Clone the repository
git clone https://github.com/calltelemetry/ct-review-bot.git
cd ct-review-bot

# Install npm dependencies
npm install

# Run 568+ passing unit, integration, and benchmark tests
npm test
```

---

### Step 2: Configure Environment (`.env`)
Create a `.env` file in the root directory:
```ini
GITHUB_APP_ID=4385771
GITHUB_APP_CLIENT_ID=Iv23liHmE9qxSkdvGMMJ
GITHUB_APP_CLIENT_SECRET=your_client_secret
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."

# Doppler Secret Routing for Context7 MCP
DOPPLER_TOKEN=dp.pt.your_doppler_token

# OmniRoute Provider Routing
OMNIROUTE_BASE_URL=http://localhost:3000
```

---

### Step 3: Add Repository Configuration (`.ct-review.yaml`)
Place `.ct-review.yaml` or `.coderabbit.yaml` in your repository root:
```yaml
version: "1.0"

ticketEnforcement:
  required: true
  providers: [linear, jira, github]

quorum:
  minApprovals: 4
  personas: [security, architecture, performance, quality]
  effortLevel: low
  confidenceThreshold: 90

personaModels:
  security: "claude-5-sonnet"
  architecture: "gpt-5.6-sol"
  performance: "deepseek/deepseek-v4-pro"
  quality: "z-ai/glm-5.2"

asciiArt: true
```

---

### Step 4: Deploy to DigitalOcean Kubernetes (DOKS)
```bash
# Log in to DigitalOcean Container Registry
doctl registry login

# Build & Push linux/amd64 multi-arch container image
docker buildx build --platform linux/amd64 -t registry.digitalocean.com/calltelemetry/ct-review-bot:v1.0.7 --push .

# Apply Kubernetes manifests
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

---

## 📡 REST Query API Reference

`ct-review-bot` exposes high-speed REST endpoints for local agents and review pipelines:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/memory/query` | `POST` | Query persistent PR review memory & resolved nit patterns |
| `/api/code/symbol-graph` | `GET` / `POST` | Retrieve AST symbol call graphs, definitions, and references |
| `/api/code/search` | `POST` | Semantic vector & keyword code search across indexed repositories |
| `/api/memory/record` | `POST` | Record review outcomes and ADR learnings into `.ct-memory/` |
| `/api/router/providers` | `POST` | Dynamically register new LLM models at runtime without redeployment |

---

## 👥 Quorum Persona Roster

| Persona | Flagship Model | Effort Level | Target SLA |
| :--- | :--- | :--- | :--- |
| 🛡️ **Security** | `claude-5-sonnet` | `low` / `medium` | P0 PII & Fail-Closed Gating |
| 📐 **Architecture** | `gpt-5.6-sol` | `low` / `medium` | ADR 0167 Structural Compliance |
| ⚡ **Performance** | `deepseek/deepseek-v4-pro` | `low` | Token Budget & Latency (<50ms) |
| 🔍 **Quality** | `z-ai/glm-5.2` | `low` | Bash 3.2 Safety & Path Filters |

---

## 📄 License
Distributed under the MIT License. See `LICENSE` for details.
