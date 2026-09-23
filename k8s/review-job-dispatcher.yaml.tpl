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
  CT_REVIEW_DATA_DIR: "/tmp/.ct-memory"
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
    # REL-896: `list` lets the abandoned-run reaper read the Go operator's
    # delegated-failure signal (FailurePublication condition) directly off
    # the CR so it can claim an exact attempt before terminal_deadline
    # instead of only after. Still no `watch`, `update`, `patch`, or `delete`
    # -- this component only ever reads the resource and its own two
    # existing verbs create/get it for run-secret recovery.
    verbs: ["get", "list", "create"]
  # REL-586: provisions one Secret per publishing run, holding tokens minted from
  # the installed GitHub App and scoped to that run's repository.
  #
  # `get` and `create` are the minimum verbs for split-write recovery. Reads are
  # accepted only for the exact run-derived name and then identity-checked in the
  # dispatcher before its publish-token digest is bound. `delete` or `patch` remain
  # forbidden because Kubernetes cannot scope those verbs to one Secret name and
  # they could reach the App private key, gateway credential, or ingress TLS key.
  - apiGroups: [""]
    resources: ["secrets"]
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
          ports:
            - name: metrics
              containerPort: 9090
              protocol: TCP
          # REL-1053: readiness is per pod. /ready fails until this pod's own
          # dispatch loop completes a cycle, when it stalls, and once it starts
          # shutting down. /health stays a process-level liveness check, so a
          # database outage (which stalls no loop) never restarts every replica.
          readinessProbe:
            httpGet:
              path: /ready
              port: metrics
            initialDelaySeconds: 2
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: metrics
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 2
            failureThreshold: 3
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
apiVersion: v1
kind: Service
metadata:
  name: ct-review-job-dispatcher-metrics
  namespace: ct-review-system
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: ct-review-job-dispatcher
  ports:
    - name: metrics
      protocol: TCP
      port: 9090
      targetPort: metrics
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
  policyTypes: [Ingress, Egress]
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
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: observability
          podSelector:
            matchLabels:
              app.kubernetes.io/instance: victoria-metrics
              app.kubernetes.io/name: victoria-metrics
      ports:
        - protocol: TCP
          port: 9090
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
