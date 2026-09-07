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
  # REL-586: provisions one Secret per publishing run, holding tokens minted from
  # the installed GitHub App and scoped to that run's repository.
  #
  # `create` only, deliberately. Kubernetes cannot scope a verb to a single Secret
  # name, so `delete` or `patch` here would also reach the App private key below,
  # the gateway credential, and the ingress TLS key in this namespace. A 409 is
  # treated as success instead: the run id is identity-derived and re-admission
  # does not reset terminal_deadline, so one run-secret name is only ever written
  # inside a single fifteen-minute window.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
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
            # REL-586: mints the per-run publish and read tokens. Deliberately a
            # DEDICATED Secret, not the runtime one, so deploy-review-job-dispatcher.sh
            # can keep asserting the runtime Secret holds exactly the two database
            # keys and nothing else.
            #
            # This reverses the "no publication credentials" posture this manifest
            # previously asserted. The App key has to live in exactly one of the two
            # components that could mint, and this is the lower-exposure one: no
            # ingress, no public listener, and it only ever reads leased rows. The
            # action-dispatch API is internet-facing and deliberately runs with
            # automountServiceAccountToken: false, so giving it Kubernetes write
            # access would reverse a stronger posture than this one. See ADR 0539.
            - name: GITHUB_APP_ID
              valueFrom:
                secretKeyRef:
                  name: ct-review-job-dispatcher-github-app
                  key: GITHUB_APP_ID
            - name: GITHUB_APP_PRIVATE_KEY
              valueFrom:
                secretKeyRef:
                  name: ct-review-job-dispatcher-github-app
                  key: GITHUB_APP_PRIVATE_KEY
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
