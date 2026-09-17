package controllers_test

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	reviewv1alpha2 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha2"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

// REL-903: sibling writers (dispatcher, reaper, lifecycle reconciler) legitimately
// race the operator on the same PRReviewJob and worker Job objects. A conflict must
// surface as a quiet requeue plus a counter, never as an ERROR-level reconciler
// error with a stacktrace.
func TestReconcileConvertsStatusWriteConflictIntoQuietRequeue(t *testing.T) {
	conflictArmed := false
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		WithInterceptorFuncs(interceptor.Funcs{
			SubResourceUpdate: func(ctx context.Context, c client.Client, subResourceName string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
				if conflictArmed {
					if _, isReview := obj.(*reviewv1alpha2.PRReviewJob); isReview {
						return apierrors.NewConflict(
							schema.GroupResource{Group: "review-yeti.ai", Resource: "prreviewjobs"},
							obj.GetName(), nil)
					}
				}
				return c.SubResource(subResourceName).Update(ctx, obj, opts...)
			},
		}).
		Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	// Prime the workspace and worker Job exactly like the terminal-worker test.
	for i := 0; i < 2; i++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatal(err)
		}
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}

	// Arm the conflict only for the terminal status write under test.
	conflictArmed = true
	operatorMetrics.RegisterMetrics()
	before := testCounterValue(t, "review_yeti_operator_reconcile_conflicts_total")
	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("conflict must not surface as a reconciler error, got: %v", err)
	}
	if result.RequeueAfter != 2*time.Second {
		t.Fatalf("conflict must requeue quietly, got RequeueAfter=%v", result.RequeueAfter)
	}
	if after := testCounterValue(t, "review_yeti_operator_reconcile_conflicts_total"); after != before+1 {
		t.Fatalf("conflict counter must increment: before=%v after=%v", before, after)
	}
	// Pacify the unused-import lint on operatorMetrics in strict CI (counter is
	// exported from the metrics package the wrapper uses).
	_ = operatorMetrics.ReconcileConflicts
}

func TestReconcileDoesNotSwallowNonConflictStatusErrors(t *testing.T) {
	conflictArmed2 := false
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	scheme := v1alpha2Scheme(t)
	review := v1alpha2Review(now)
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(review).
		WithStatusSubresource(&reviewv1alpha2.PRReviewJob{}).
		WithInterceptorFuncs(interceptor.Funcs{
			SubResourceUpdate: func(ctx context.Context, c client.Client, subResourceName string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
				if conflictArmed2 {
					if _, isReview := obj.(*reviewv1alpha2.PRReviewJob); isReview {
						return apierrors.NewBadRequest("not a conflict")
					}
				}
				return c.SubResource(subResourceName).Update(ctx, obj, opts...)
			},
		}).
		Build()
	reconciler := &controllers.PRReviewJobV1Alpha2Reconciler{Client: kube, Scheme: scheme, Now: func() time.Time { return now }}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: review.Namespace, Name: review.Name}}

	for i := 0; i < 2; i++ {
		if _, err := reconciler.Reconcile(context.Background(), req); err != nil {
			t.Fatal(err)
		}
	}
	var worker batchv1.Job
	if err := kube.Get(context.Background(), types.NamespacedName{Namespace: review.Namespace, Name: review.Name + "-worker"}, &worker); err != nil {
		t.Fatal(err)
	}
	worker.Status.Succeeded = 1
	if err := kube.Status().Update(context.Background(), &worker); err != nil {
		t.Fatalf("mark worker succeeded: %v", err)
	}

	conflictArmed2 = true
	if _, err := reconciler.Reconcile(context.Background(), req); err == nil {
		t.Fatal("non-conflict status write failures must still surface as reconciler errors")
	}
}

func testCounterValue(t *testing.T, name string) float64 {
	t.Helper()
	families, err := crmetrics.Registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	for _, mf := range families {
		if mf.GetName() != name {
			continue
		}
		var total float64
		for _, m := range mf.GetMetric() {
			total += m.GetCounter().GetValue()
		}
		return total
	}
	return 0
}

var _ = corev1.AddToScheme
