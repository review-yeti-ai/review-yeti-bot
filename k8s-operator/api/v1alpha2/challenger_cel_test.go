package v1alpha2_test

import (
	"strings"
	"testing"
)

// 3. Empirical Challenge: CEL Immutability.
// Attempt to mutate logicalChildId, fencingEpoch, or workerLeaseToken on an existing review.
// Verify each mutation attempt is strictly rejected by the CEL validation rule.
func TestChallengerEmpirical_CEL_LogicalChildID_Immutability(t *testing.T) {
	// 1. Mutating value from "child-alpha" to "child-beta" must be REJECTED
	t.Run("mutate value rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-alpha"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-beta"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when mutating logicalChildId, but update was accepted")
		}
		if !strings.Contains(errs.ToAggregate().Error(), "PRReviewJob spec") {
			t.Fatalf("unexpected error message: %v", errs.ToAggregate())
		}
	})

	// 2. Removing existing logicalChildId must be REJECTED
	t.Run("remove field rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-alpha"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "logicalChildId")
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when removing logicalChildId, but update was accepted")
		}
	})

	// 3. Adding logicalChildId after creation must be REJECTED
	t.Run("add field after creation rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "logicalChildId")
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-alpha"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when adding logicalChildId after creation, but update was accepted")
		}
	})

	// 4. Keeping unchanged logicalChildId must be ACCEPTED
	t.Run("preserve identical value accepted", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-alpha"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-alpha"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) > 0 {
			t.Fatalf("expected identical logicalChildId to be accepted, got errors: %v", errs.ToAggregate())
		}
	})
}

func TestChallengerEmpirical_CEL_FencingEpoch_Immutability(t *testing.T) {
	// 1. Mutating value from 2 to 3 must be REJECTED
	t.Run("mutate value rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(2)
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(3)
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when mutating fencingEpoch, but update was accepted")
		}
		if !strings.Contains(errs.ToAggregate().Error(), "PRReviewJob spec") {
			t.Fatalf("unexpected error message: %v", errs.ToAggregate())
		}
	})

	// 2. Removing existing fencingEpoch must be REJECTED
	t.Run("remove field rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(2)
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "fencingEpoch")
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when removing fencingEpoch, but update was accepted")
		}
	})

	// 3. Adding fencingEpoch after creation must be REJECTED
	t.Run("add field after creation rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "fencingEpoch")
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(2)
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when adding fencingEpoch after creation, but update was accepted")
		}
	})

	// 4. Keeping unchanged fencingEpoch must be ACCEPTED
	t.Run("preserve identical value accepted", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(5)
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["fencingEpoch"] = int64(5)
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) > 0 {
			t.Fatalf("expected identical fencingEpoch to be accepted, got errors: %v", errs.ToAggregate())
		}
	})
}

func TestChallengerEmpirical_CEL_WorkerLeaseToken_Immutability(t *testing.T) {
	// 1. Mutating value from "lease-tok-1" to "lease-tok-2" must be REJECTED
	t.Run("mutate value rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-1"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-2"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when mutating workerLeaseToken, but update was accepted")
		}
		if !strings.Contains(errs.ToAggregate().Error(), "PRReviewJob spec") {
			t.Fatalf("unexpected error message: %v", errs.ToAggregate())
		}
	})

	// 2. Removing existing workerLeaseToken must be REJECTED
	t.Run("remove field rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-1"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "workerLeaseToken")
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when removing workerLeaseToken, but update was accepted")
		}
	})

	// 3. Adding workerLeaseToken after creation must be REJECTED
	t.Run("add field after creation rejected", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			delete(spec, "workerLeaseToken")
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-1"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) == 0 {
			t.Fatal("expected CEL validation failure when adding workerLeaseToken after creation, but update was accepted")
		}
	})

	// 4. Keeping unchanged workerLeaseToken must be ACCEPTED
	t.Run("preserve identical value accepted", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-1"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["workerLeaseToken"] = "lease-tok-1"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) > 0 {
			t.Fatalf("expected identical workerLeaseToken to be accepted, got errors: %v", errs.ToAggregate())
		}
	})
}

// Sneak attack: attempting to mutate fencing/lease fields while legitimately flipping cancelRequested=true
func TestChallengerEmpirical_CEL_SneakMutationWithCancelFlip(t *testing.T) {
	cases := map[string]struct {
		before func(spec map[string]interface{})
		after  func(spec map[string]interface{})
	}{
		"sneak logicalChildId mutation with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["logicalChildId"] = "child-original"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["logicalChildId"] = "child-mutated"
			},
		},
		"sneak fencingEpoch mutation with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["fencingEpoch"] = int64(1)
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["fencingEpoch"] = int64(2)
			},
		},
		"sneak workerLeaseToken mutation with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["workerLeaseToken"] = "tok-original"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				spec["workerLeaseToken"] = "tok-mutated"
			},
		},
		"sneak deletion of logicalChildId with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["logicalChildId"] = "child-original"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				delete(spec, "logicalChildId")
			},
		},
		"sneak deletion of fencingEpoch with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["fencingEpoch"] = int64(1)
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				delete(spec, "fencingEpoch")
			},
		},
		"sneak deletion of workerLeaseToken with cancel flip": {
			before: func(spec map[string]interface{}) {
				spec["workerLeaseToken"] = "tok-original"
			},
			after: func(spec map[string]interface{}) {
				spec["cancelRequested"] = true
				delete(spec, "workerLeaseToken")
			},
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			oldObj := withSpec(t, tc.before)
			newObj := withSpec(t, tc.after)
			errs := validateUpdate(t, oldObj, newObj)
			if len(errs) == 0 {
				t.Fatalf("sneak attack update was accepted, want CEL rejection")
			}
			if !strings.Contains(errs.ToAggregate().Error(), "PRReviewJob spec") {
				t.Fatalf("unexpected rejection error: %v", errs.ToAggregate())
			}
		})
	}

	// Conversely, clean cancelRequested flip with all three fields preserved MUST succeed
	t.Run("clean cancel flip with preserved fields accepted", func(t *testing.T) {
		oldObj := withSpec(t, func(spec map[string]interface{}) {
			spec["logicalChildId"] = "child-1"
			spec["fencingEpoch"] = int64(3)
			spec["workerLeaseToken"] = "tok-1"
		})
		newObj := withSpec(t, func(spec map[string]interface{}) {
			spec["cancelRequested"] = true
			spec["cancelReason"] = "superseded"
			spec["logicalChildId"] = "child-1"
			spec["fencingEpoch"] = int64(3)
			spec["workerLeaseToken"] = "tok-1"
		})
		errs := validateUpdate(t, oldObj, newObj)
		if len(errs) > 0 {
			t.Fatalf("clean cancel flip with preserved fields was rejected: %v", errs.ToAggregate())
		}
	})
}
