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

package controllers

import (
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrl "sigs.k8s.io/controller-runtime"

	operatorMetrics "github.com/calltelemetry/ct-review-bot/k8s-operator/pkg/metrics"
)

// conflictRequeueBackoff is the quiet requeue delay for optimistic-concurrency
// write conflicts. The controller-runtime default backoff would retry the same
// object anyway, but only after logging the error at ERROR level with a full
// stacktrace every time.
const conflictRequeueBackoff = 2 * time.Second

// conflictRequeue is the single REL-903 conflict-conversion policy shared by the
// v1alpha1 and v1alpha2 reconcilers.
//
// The dispatcher, reaper, and lifecycle reconciler legitimately mutate the same
// PRReviewJob and worker Job objects during job transitions; every writer loses
// the occasional race and controller-runtime would retry it regardless. Surfacing
// those races as ERROR-level reconciler errors with stacktraces buries real
// failures. A conflict here changes nothing about review semantics: the object
// was concurrently modified, the retry will re-read the latest state, and the
// outcome another writer already recorded stays authoritative.
func conflictRequeue(result ctrl.Result, err error) (ctrl.Result, error) {
	if err != nil && apierrors.IsConflict(err) {
		operatorMetrics.ReconcileConflicts.Inc()
		return ctrl.Result{RequeueAfter: conflictRequeueBackoff}, nil
	}
	return result, err
}
