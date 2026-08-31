package main

import "testing"

func TestOperatorDisabledUnlessExplicitlyEnabled(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "", want: false},
		{value: "false", want: false},
		{value: "1", want: false},
		{value: "yes", want: false},
		{value: "TRUE ", want: true},
		{value: " true\n", want: true},
	} {
		t.Run(test.value, func(t *testing.T) {
			if got := operatorEnabled(func(string) string { return test.value }); got != test.want {
				t.Fatalf("operatorEnabled(%q) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}
