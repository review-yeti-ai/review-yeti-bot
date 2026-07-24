apiVersion: apps/v1
kind: Deployment
metadata:
  name: ct-review-bot
  namespace: ct-review-system
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ct-review-bot
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ct-review-bot
    spec:
      serviceAccountName: ct-review-bot
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: ct-review-bot
          image: ${CT_REVIEW_BOT_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: ct-review-bot-config
            - secretRef:
                name: ct-review-bot-runtime
          securityContext:
            runAsUser: 1000
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: tmp
              mountPath: /tmp
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            periodSeconds: 10
            failureThreshold: 12
          livenessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 20
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 2Gi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ct-review-bot-data
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ct-review-bot
  namespace: ct-review-system
automountServiceAccountToken: false
