/*
Copyright 2026 CallTelemetry.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"fmt"
	"os"
	"strings"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/job"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

var (
	scheme = runtime.NewScheme()
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(reviewv1alpha1.AddToScheme(scheme))
	utilruntime.Must(reviewv1alpha2.AddToScheme(scheme))
	metrics.RegisterMetrics()
}

func main() {
	if !operatorEnabled(os.Getenv) {
		fmt.Println("k8s-operator disabled; set REVIEW_YETI_OPERATOR_ENABLED=true to start the controller")
		return
	}
	if err := runOperator(); err != nil {
		fmt.Fprintf(os.Stderr, "k8s-operator failed: %v\n", err)
		os.Exit(1)
	}
}

func operatorEnabled(getenv func(string) string) bool {
	return strings.EqualFold(strings.TrimSpace(getenv("REVIEW_YETI_OPERATOR_ENABLED")), "true")
}

func runOperator() error {
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                        scheme,
		Cache:                         cache.Options{DefaultNamespaces: map[string]cache.Config{job.Namespace: {}}},
		Metrics:                       metricsserver.Options{BindAddress: envOr("REVIEW_YETI_OPERATOR_METRICS_ADDR", ":8080")},
		HealthProbeBindAddress:        envOr("REVIEW_YETI_OPERATOR_HEALTH_ADDR", ":8081"),
		LeaderElection:                true,
		LeaderElectionID:              "ct-review-yeti-operator",
		LeaderElectionNamespace:       job.Namespace,
		LeaderElectionReleaseOnCancel: true,
	})
	if err != nil {
		return fmt.Errorf("create manager: %w", err)
	}

	// The legacy v1alpha1 reconciler is deliberately not registered. Its
	// historical contract permits floating images and process-local capacity;
	// only the immutable v1alpha2 receipt-only path may be enabled.
	v1alpha2 := &controllers.PRReviewJobV1Alpha2Reconciler{
		Client:            mgr.GetClient(),
		Scheme:            mgr.GetScheme(),
		MaxConcurrentJobs: 4,
	}
	if err := v1alpha2.SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setup v1alpha2 reconciler: %w", err)
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return fmt.Errorf("register health check: %w", err)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return fmt.Errorf("register readiness check: %w", err)
	}
	return mgr.Start(ctrl.SetupSignalHandler())
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
