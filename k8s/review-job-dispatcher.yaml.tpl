apiVersion: v1
kind: ConfigMap
metadata:
  name: ct-review-job-dispatcher
  namespace: ct-review-system
data:
  NODE_ENV: production
  REVIEW_JOB_DISPATCH_ENABLED: "true"
  REVIEW_JOB_NAMESPACE: ct-review-system
  REVIEW_JOB_WORKER_IMAGE: "${CT_REVIEW_WORKER_IMAGE}"
  REVIEW_JOB_RUNNER_MODE: "${CT_REVIEW_RUNNER_MODE}"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ct-review-job-dispatcher
  namespace: ct-review-system
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ct-review-job-dispatcher
  namespace: ct-review-system
rules:
  - apiGroups: ["review-yeti.ai"]
    resources: ["prreviewjobs"]
    verbs: ["get", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ct-review-job-dispatcher
  namespace: ct-review-system
subjects:
  - kind: ServiceAccount
    name: ct-review-job-dispatcher
    namespace: ct-review-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ct-review-job-dispatcher
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-job-dispatcher
  namespace: ct-review-system
  labels:
    app.kubernetes.io/name: ct-review-job-dispatcher
    app.kubernetes.io/component: queue-consumer
spec:
  replicas: 0
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ct-review-job-dispatcher
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ct-review-job-dispatcher
        app.kubernetes.io/component: queue-consumer
    spec:
      serviceAccountName: ct-review-job-dispatcher
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
        - name: review-job-dispatcher
          image: ${CT_REVIEW_JOB_DISPATCHER_IMAGE}
          imagePullPolicy: IfNotPresent
          command: [node, dist/reviewJobDispatcherIndex.js]
          envFrom:
            - configMapRef:
                name: ct-review-job-dispatcher
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ct-review-job-dispatcher-runtime
                  key: DATABASE_URL
            - name: DATABASE_CA_CERT
              valueFrom:
                secretKeyRef:
                  name: ct-review-job-dispatcher-runtime
                  key: DATABASE_CA_CERT
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 16Mi
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-job-dispatcher-default-deny
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-job-dispatcher
  policyTypes: [Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ct-review-job-dispatcher-allowed
  namespace: ct-review-system
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ct-review-job-dispatcher
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
    - ports:
        - protocol: TCP
          port: 443
    - ports:
        - protocol: TCP
          port: 25060
