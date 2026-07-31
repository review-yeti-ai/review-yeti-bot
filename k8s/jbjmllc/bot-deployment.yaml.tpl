apiVersion: v1
kind: ServiceAccount
metadata:
  name: ct-review-bot
  namespace: jbjmllc-review-system
  labels:
    app: ct-review-bot
    instance: jbjmllc
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-bot
  namespace: jbjmllc-review-system
  labels:
    app: ct-review-bot
    instance: jbjmllc
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: ct-review-bot
      instance: jbjmllc
  template:
    metadata:
      labels:
        app: ct-review-bot
        instance: jbjmllc
    spec:
      serviceAccountName: ct-review-bot
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        runAsNonRoot: true
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      imagePullSecrets:
        - name: calltelemetry
      containers:
        - name: ct-review-bot
          image: ${CT_REVIEW_BOT_IMAGE}
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          envFrom:
            - configMapRef:
                name: ct-review-bot-config
            - secretRef:
                name: ct-review-bot-runtime
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: tmp
              mountPath: /tmp
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 5
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ct-review-bot-data
        - name: tmp
          emptyDir: {}
