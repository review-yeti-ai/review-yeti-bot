apiVersion: v1
kind: ConfigMap
metadata:
  name: ct-review-action-dispatch
  namespace: ct-review-system
data:
  NODE_ENV: production
  HOST: 0.0.0.0
  PORT: "3000"
  ACTION_DISPATCH_ENABLED: "true"
  ACTION_DISPATCH_ALLOW_APP_GATE: "false"
  ACTION_DISPATCH_REPOSITORY_IDS: "${ACTION_DISPATCH_REPOSITORY_IDS}"
  ACTION_DISPATCH_OWNER_IDS: "${ACTION_DISPATCH_OWNER_IDS}"
  ACTION_DISPATCH_WORKFLOW_REFS: "${ACTION_DISPATCH_WORKFLOW_REFS}"
  ACTION_DISPATCH_WORKFLOW_SHAS: "${ACTION_DISPATCH_WORKFLOW_SHAS}"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ct-review-action-dispatch
  namespace: ct-review-system
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-action-dispatch
  namespace: ct-review-system
  labels:
    app.kubernetes.io/name: ct-review-action-dispatch
    app.kubernetes.io/component: admission
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: ct-review-action-dispatch
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ct-review-action-dispatch
        app.kubernetes.io/component: admission
    spec:
      serviceAccountName: ct-review-action-dispatch
      automountServiceAccountToken: false
      imagePullSecrets:
        - name: calltelemetry
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: action-dispatch
          image: ${CT_REVIEW_DISPATCH_IMAGE}
          imagePullPolicy: IfNotPresent
          command: [node, dist/dispatchIndex.js]
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: ct-review-action-dispatch
            - secretRef:
                name: ct-review-action-dispatch-runtime
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          startupProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 2
            timeoutSeconds: 1
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 32Mi
---
apiVersion: v1
kind: Service
metadata:
  name: ct-review-action-dispatch
  namespace: ct-review-system
spec:
  selector:
    app.kubernetes.io/name: ct-review-action-dispatch
  ports:
    - name: http
      port: 3000
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ct-review-action-dispatch
  namespace: ct-review-system
  annotations:
    kubernetes.io/ingress.class: haproxy-ct-dev
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: haproxy-ct-dev
  tls:
    - hosts: [review-bot.calltelemetry.com]
      secretName: review-bot-calltelemetry-com-tls
  rules:
    - host: review-bot.calltelemetry.com
      http:
        paths:
          - path: /api/dispatch/action
            pathType: Exact
            backend:
              service:
                name: ct-review-action-dispatch
                port:
                  name: http
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-action-dispatch-default-deny
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-action-dispatch
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-action-dispatch-allowed
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-action-dispatch
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ct-dev
          podSelector:
            matchLabels:
              app.kubernetes.io/name: haproxy-ingress
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - ports:
        - protocol: TCP
          port: 443
    - ports:
        - protocol: TCP
          port: 25060
