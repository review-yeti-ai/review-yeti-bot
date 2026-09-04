{{/*
Expand the name of the chart.
*/}}
{{- define "review-yeti.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "review-yeti.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "review-yeti.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "review-yeti.labels" -}}
helm.sh/chart: {{ include "review-yeti.chart" . }}
app.kubernetes.io/name: {{ include "review-yeti.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for dispatcher
*/}}
{{- define "review-yeti.dispatcher.selectorLabels" -}}
app.kubernetes.io/name: {{ include "review-yeti.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: dispatcher
{{- end }}

{{/*
Selector labels for operator
*/}}
{{- define "review-yeti.operator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "review-yeti.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: operator
{{- end }}

{{/*
Dispatcher full name
*/}}
{{- define "review-yeti.dispatcher.fullname" -}}
{{- printf "%s-dispatcher" (include "review-yeti.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Operator full name
*/}}
{{- define "review-yeti.operator.fullname" -}}
{{- printf "%s-operator" (include "review-yeti.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Dispatcher service account name
*/}}
{{- define "review-yeti.dispatcher.serviceAccountName" -}}
{{- if .Values.dispatcher.serviceAccount.create }}
{{- default (include "review-yeti.dispatcher.fullname" .) .Values.dispatcher.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.dispatcher.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Operator service account name
*/}}
{{- define "review-yeti.operator.serviceAccountName" -}}
{{- if .Values.operator.serviceAccount.create }}
{{- default (include "review-yeti.operator.fullname" .) .Values.operator.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.operator.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name
*/}}
{{- define "review-yeti.secretName" -}}
{{- if .Values.secrets.existingSecretName }}
{{- .Values.secrets.existingSecretName }}
{{- else }}
{{- printf "%s-secrets" (include "review-yeti.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
