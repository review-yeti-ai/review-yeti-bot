apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: omniroute
  namespace: ct-review-system
spec:
  serviceName: omniroute
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: omniroute
  template:
    metadata:
      labels:
        app.kubernetes.io/name: omniroute
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10002
        runAsGroup: 10002
        fsGroup: 10002
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: omniroute
          image: ${OMNIROUTE_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 20128
          env:
            - name: DATA_DIR
              value: /data
            - name: PORT
              value: "20128"
            - name: STORAGE_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: omniroute-runtime
                  key: STORAGE_ENCRYPTION_KEY
            - name: OMNIROUTE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: omniroute-runtime
                  key: OMNIROUTE_API_KEY
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
            - name: tmp
              mountPath: /tmp
          readinessProbe:
            httpGet:
              path: /api/monitoring/health
              port: http
            periodSeconds: 10
            failureThreshold: 18
          livenessProbe:
            httpGet:
              path: /api/monitoring/health
              port: http
            periodSeconds: 20
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "4"
              memory: 8Gi
      volumes:
        - name: tmp
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 20Gi
