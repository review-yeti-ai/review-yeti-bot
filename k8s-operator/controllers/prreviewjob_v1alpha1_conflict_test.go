package controllers_test

import (
	"context"
	"testing"
	"time"

	reviewv1alpha1 "github.com/calltelemetry/ct-review-bot/k8s-operator/api/v1alpha1"
	"github.com/calltelemetry/ct-review-bot/k8s-operator/controllers"
	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// REL-903: the v1alpha1 wrapper must convert optimistic-concurrency write
// failures into the same quiet, metric-counted requeue as the v1alpha2
// controller — both delegations share one policy in conflictRequeue.go, and this
// test pins the v1alpha1 wiring itself.
func TestPRReviewJobV1Alpha1ReconcilerConvertsConflictIntoQuietRequeue(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := reviewv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("register scheme: %v", err)
	}
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				if _, isReview := obj.(*reviewv1alpha1.PRReviewJob); isReview {
					return errors.NewConflict(
						schema.GroupResource{Group: "review.calltelemetry.com", Resource: "prreviewjobs"},
						key.Name, nil)
				}
				return c.Get(ctx, key, obj, opts...)
			},
		}).
		Build()
	reconciler := &controllers.PRReviewJobReconciler{Client: kube, Scheme: scheme}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "ct-review-system", Name: "ct-review-11111111111111111111111111111111"}}

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
}

func TestPRReviewJobV1Alpha1ReconcilerDoesNotSwallowNonConflictErrors(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := reviewv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("register scheme: %v", err)
	}
	kube := fake.NewClientBuilder().
		WithScheme(scheme).
		WithInterceptorFuncs(interceptor.Funcs{
			Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				if _, isReview := obj.(*reviewv1alpha1.PRReviewJob); isReview {
					return errors.NewBadRequest("not a conflict")
				}
				return c.Get(ctx, key, obj, opts...)
			},
		}).
		Build()
	reconciler := &controllers.PRReviewJobReconciler{Client: kube, Scheme: scheme}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "ct-review-system", Name: "ct-review-11111111111111111111111111111111"}}

	if _, err := reconciler.Reconcile(context.Background(), req); err == nil {
		t.Fatal("non-conflict failures must still surface as reconciler errors")
	}
}
