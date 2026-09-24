package v1alpha2_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// REL-1073: the Go types declared spec.cancelRequested and its CEL transition
// rule, but the committed CRD was never regenerated. The API server pruned the
// field and every cancellation "succeeded" without cancelling anything. This
// test regenerates the CRD with the Makefile's pinned controller-gen and fails
// when the committed manifest differs by a single byte.
//
// It needs the Go module proxy (controller-gen and its pinned toolchain are
// fetched with `go run`); `go test -short` skips it for offline work. CI runs
// the operator tests without -short.
func TestCommittedCRDMatchesControllerGen(t *testing.T) {
	if testing.Short() {
		t.Skip("regenerating the CRD needs the Go module proxy; run without -short")
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	makefile, err := os.ReadFile(filepath.Join(moduleRoot, "Makefile"))
	if err != nil {
		t.Fatalf("read Makefile: %v", err)
	}
	version := makeVariable(t, makefile, "CONTROLLER_GEN_VERSION")
	toolchain := makeVariable(t, makefile, "CONTROLLER_GEN_GO_TOOLCHAIN")

	committedPath := filepath.Join(moduleRoot, "config", "crd", "bases", "review-yeti.ai_prreviewjobs.yaml")
	committed, err := os.ReadFile(committedPath)
	if err != nil {
		t.Fatalf("read committed CRD: %v", err)
	}
	if !bytes.Contains(committed, []byte("controller-gen.kubebuilder.io/version: "+version+"\n")) {
		t.Fatalf("committed CRD was not produced by the Makefile's controller-gen %s", version)
	}

	out := t.TempDir()
	args := []string{"run"}
	env := append(os.Environ(), "GOTOOLCHAIN="+toolchain, "GOWORK=off")
	// Mirrors the Makefile: new macOS loaders need LC_UUID, which the pinned
	// toolchain's internal linker omits.
	if runtime.GOOS == "darwin" {
		env = append(env, "CGO_ENABLED=1")
		args = append(args, "-ldflags=-linkmode=external")
	}
	args = append(args,
		"sigs.k8s.io/controller-tools/cmd/controller-gen@"+version,
		"crd", `paths=./api/v1alpha2`, "output:crd:artifacts:config="+out)
	cmd := exec.Command("go", args...)
	cmd.Dir = moduleRoot
	cmd.Env = env
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("controller-gen failed: %v\n%s", err, output)
	}
	generated, err := os.ReadFile(filepath.Join(out, "review-yeti.ai_prreviewjobs.yaml"))
	if err != nil {
		t.Fatalf("read generated CRD: %v", err)
	}
	if !bytes.Equal(committed, generated) {
		t.Fatalf("config/crd/bases/review-yeti.ai_prreviewjobs.yaml is stale; run `make generate` in k8s-operator and commit the result\n%s",
			firstDifference(string(committed), string(generated)))
	}
}

func makeVariable(t *testing.T, makefile []byte, name string) string {
	t.Helper()
	match := regexp.MustCompile(`(?m)^` + name + `\s*:=\s*(\S+)\s*$`).FindSubmatch(makefile)
	if match == nil {
		t.Fatalf("Makefile does not pin %s", name)
	}
	return string(match[1])
}

func firstDifference(committed, generated string) string {
	a, b := strings.Split(committed, "\n"), strings.Split(generated, "\n")
	for index := 0; index < len(a) || index < len(b); index++ {
		var left, right string
		if index < len(a) {
			left = a[index]
		}
		if index < len(b) {
			right = b[index]
		}
		if left != right {
			return "first difference at line " + strconv.Itoa(index+1) + ":\n committed: " + left + "\n generated: " + right
		}
	}
	return "files differ"
}
