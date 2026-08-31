apiVersion: v1
kind: ServiceAccount
metadata:
  name: ct-review-yeti-operator
  namespace: ct-review-system
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ct-review-yeti-operator
  namespace: ct-review-system
rules:
  - apiGroups: ["review-yeti.ai"]
    resources: ["prreviewjobs"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: ["review-yeti.ai"]
    resources: ["prreviewjobs/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ct-review-yeti-operator
  namespace: ct-review-system
subjects:
  - kind: ServiceAccount
    name: ct-review-yeti-operator
    namespace: ct-review-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ct-review-yeti-operator
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-yeti-operator
  namespace: ct-review-system
  labels:
    app.kubernetes.io/name: ct-review-yeti-operator
    app.kubernetes.io/component: operator
spec:
  # This package is inert until a separately reviewed qualification explicitly
  # scales it. Production review traffic remains on the central Action path.
  replicas: 0
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ct-review-yeti-operator
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ct-review-yeti-operator
        app.kubernetes.io/component: operator
    spec:
      serviceAccountName: ct-review-yeti-operator
      automountServiceAccountToken: true
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
        - name: operator
          image: ${CT_REVIEW_OPERATOR_IMAGE}
          imagePullPolicy: IfNotPresent
          command: ["/manager"]
          env:
            - name: REVIEW_YETI_OPERATOR_ENABLED
              value: "false"
            - name: REVIEW_YETI_OPERATOR_METRICS_ADDR
              value: ":8080"
            - name: REVIEW_YETI_OPERATOR_HEALTH_ADDR
              value: ":8081"
          ports:
            - name: metrics
              containerPort: 8080
            - name: health
              containerPort: 8081
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            capabilities:
              drop: [ALL]
          startupProbe:
            httpGet:
              path: /healthz
              port: health
            periodSeconds: 2
            timeoutSeconds: 1
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /readyz
              port: health
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: health
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-yeti-operator-default-deny
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-yeti-operator
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-yeti-operator-allowed
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-yeti-operator
  policyTypes: [Egress]
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
    # Render KUBERNETES_API_CIDR from the cluster's control-plane endpoint.
    # A concrete CIDR is required; a broad 0.0.0.0/0 rule is forbidden.
    - to:
        - ipBlock:
            cidr: "${KUBERNETES_API_CIDR}"
      ports:
        - protocol: TCP
          port: 443
