# Operator & Deployment Guide: `ct-review-bot`

**Target Platform**: Kubernetes (DigitalOcean Kubernetes / DOKS, EKS, GKE)  
**Deployment Tool**: Helm 3 / kubectl  
**Service Port**: 3000  

---

## 1. Environment & Configuration Reference

`ct-review-bot` is configured via environment variables and mounted volume files:

| Environment Variable | Required | Default Value | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP service listening port |
| `HOST` | No | `0.0.0.0` | Host network binding interface (`0.0.0.0` for container ingress) |
| `NODE_ENV` | No | `production` | Node runtime environment mode (`production` / `development`) |
| `WEBHOOK_SECRET` | Yes | - | Primary GitHub Webhook HMAC secret key |
| `GITHUB_WEBHOOK_SECRET` | No | - | Secondary fallback GitHub Webhook secret key |
| `CT_SECRET_MASTER_KEY` | Yes | - | 64-char Hex master key for AES-256-GCM secret encryption |
| `CT_SECRET_SALT` | No | `ct-review-bot-master-salt` | PBKDF2 salt for master key derivation |
| `CT_REVIEW_DB_PATH` | No | `/app/data/ct-review.db` | SQLite database file path (or `:memory:`) |
| `CT_REVIEW_CONFIG_PATH` | No | `/app/config/.ct-review.yaml` | System default org-wide configuration file path |
| `CT_REVIEW_CONSTITUTION_PATH` | No | `/app/config/constitution.md` | System default org-wide constitution markdown path |
| `OMNIROUTE_BASE_URL` | No | `http://127.0.0.1:9090` | Base URL for OmniRoute LLM Gateway proxy |
| `GITHUB_API_BASE_URL` | No | `https://api.github.com` | Base URL for GitHub REST API (or GitHub Enterprise URL) |

---

## 2. Kubernetes Manifests Specification

### Deployment (`k8s/deployment.yaml`)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-bot
  namespace: ct-review-system
  labels:
    app.kubernetes.io/name: ct-review-bot
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ct-review-bot
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ct-review-bot
    spec:
      containers:
        - name: ct-review-bot
          image: calltelemetry/ct-review-bot:1.0.0
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
              name: http
          envFrom:
            - configMapRef:
                name: ct-review-bot-config
            - secretRef:
                name: ct-review-bot-secrets
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1024Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: storage-volume
              mountPath: /app/data
      volumes:
        - name: storage-volume
          persistentVolumeClaim:
            claimName: ct-review-bot-pvc
```

### ConfigMap (`k8s/configmap.yaml`)
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ct-review-bot-config
  namespace: ct-review-system
data:
  PORT: "3000"
  HOST: "0.0.0.0"
  NODE_ENV: "production"
  CT_REVIEW_DB_PATH: "/app/data/ct-review.db"
  OMNIROUTE_BASE_URL: "http://omniroute-gateway.ct-review-system.svc.cluster.local:9090"
  GITHUB_API_BASE_URL: "https://api.github.com"
```

### Secret (`k8s/secret.yaml`)
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ct-review-bot-secrets
  namespace: ct-review-system
type: Opaque
stringData:
  WEBHOOK_SECRET: "your-production-github-webhook-secret-key-32-chars"
  CT_SECRET_MASTER_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  CT_SECRET_SALT: "production-pbkdf2-salt-value"
```

### Service (`k8s/service.yaml`)
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ct-review-bot
  namespace: ct-review-system
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    app.kubernetes.io/name: ct-review-bot
```

### Ingress (`k8s/ingress.yaml`)
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ct-review-bot-ingress
  namespace: ct-review-system
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - review-bot.yourdomain.com
      secretName: ct-review-bot-tls
  rules:
    - host: review-bot.yourdomain.com
      http:
        paths:
          - path: /webhook
            pathType: Prefix
            backend:
              service:
                name: ct-review-bot
                port:
                  number: 80
          - path: /health
            pathType: Exact
            backend:
              service:
                name: ct-review-bot
                port:
                  number: 80
```

---

## 3. Secret Rotation Protocols

### 1. Webhook Secret Rotation
To rotate `WEBHOOK_SECRET` without dropping GitHub webhook events:
1. Generate new webhook secret `NEW_SECRET`.
2. Configure GitHub Organization Webhook settings to use `NEW_SECRET`.
3. Set `GITHUB_WEBHOOK_SECRET` in Kubernetes Secret to `OLD_SECRET` (fallback), and update `WEBHOOK_SECRET` to `NEW_SECRET`.
4. Perform `kubectl rollout restart deployment/ct-review-bot -n ct-review-system`.
5. After verification, remove `GITHUB_WEBHOOK_SECRET`.

### 2. Master Key Rotation (AES-256-GCM)
`SecureSecretStore` includes automatic legacy master key fallback and auto-migration:
1. Pass new key `NEW_MASTER_KEY` via `CT_SECRET_MASTER_KEY`.
2. Upon startup, `SecureSecretStore` attempts decryption with `NEW_MASTER_KEY`. If decryption fails, it falls back to `this.legacyMasterKey`, decrypts the payload, and re-encrypts it using `NEW_MASTER_KEY`.
3. Check logs for `Migrated legacy secret key '...' to PBKDF2 master key.` to confirm migration.

---

## 4. Monitoring & Telemetry

### Health Check Endpoints
- **Liveness Probe**: `GET /health`
  - Returns `HTTP 200 OK` with JSON metadata:
  ```json
  {
    "status": "ok",
    "service": "ct-review-bot",
    "timestamp": "2026-07-24T16:00:00.000Z",
    "uptimeSeconds": 12450.5,
    "router": {
      "activeProviders": 4,
      "totalProviders": 4,
      "poolStatus": "ok"
    }
  }
  ```
- **Router Status & Metrics**: `GET /api/router/status`
  - Returns complete snapshot of provider health, circuit breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`), and token usage metrics per persona.

---

## 5. Troubleshooting & Incident Playbook

| Incident Symptom | Root Cause | Resolution Action |
|---|---|---|
| `HTTP 401 Invalid or missing signature` on webhooks | Secret mismatch or malformed payload header | Verify `WEBHOOK_SECRET` in `k8s/secret.yaml` matches GitHub Webhook settings. Ensure reverse proxy preserves `X-Hub-Signature-256` header. |
| `ProviderPoolExhaustedError: All providers failed` | All upstream LLM API providers rate limited or offline | Check `/api/router/status`. Verify API keys in `SecureSecretStore`. If 401/429 tripped circuits, wait for cooldown timer or register fallback provider. |
| `ConfigValidationError: YAML must be a key-value mapping object` | User repository `.ct-review.yaml` is formatted as YAML list | Fix user repository `.ct-review.yaml` file to be a valid key-value mapping object. |
| `SQLite storage engine unavailable, failing over` | Native `better-sqlite3` module ABI version mismatch | Safe operational fallback to JSON storage engine (`JsonFileDiffStateStorage`). No data loss; rebuild native module with `npm rebuild` for native performance. |
