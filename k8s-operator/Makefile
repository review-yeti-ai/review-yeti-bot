# Image & Binary Configuration
BINARY_NAME ?= bin/manager
MAIN_SRC ?= main.go
CRD_DIR ?= config/crd/bases
CRD_FILES ?= $(CRD_DIR)/review.calltelemetry.com_prreviewjobs.yaml $(CRD_DIR)/review-yeti.ai_prreviewjobs.yaml

# Go Toolchain Settings
GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)
CGO_ENABLED ?= 0

.PHONY: all build test crd clean fmt vet run help

all: fmt vet build test

## build: Build the operator binary
build: fmt vet
	@echo "==> Building operator binary $(BINARY_NAME)..."
	@mkdir -p bin
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS) GOARCH=$(GOARCH) go build -ldflags="-w -s" -o $(BINARY_NAME) $(MAIN_SRC)

## test: Run unit tests with coverage report
test:
	@echo "==> Running Go unit tests..."
	go test -v ./... -coverprofile=cover.out

## crd: Validate CRD manifest existence and structure
crd:
	@echo "==> Verifying CRD manifests..."
	@for crd in $(CRD_FILES); do \
		test -f "$$crd" || (echo "Error: $$crd missing!" && exit 1); \
		echo "CRD manifest $$crd present and verified."; \
	done

## clean: Clean build binaries and coverage outputs
clean:
	@echo "==> Cleaning build artifacts..."
	rm -rf bin/ cover.out

## fmt: Format Go source code
fmt:
	@echo "==> Formatting code..."
	go fmt ./...

## vet: Examine Go source code for suspicious constructs
vet:
	@echo "==> Vetting code..."
	go vet ./...

## run: Run operator locally against configured kubeconfig
run: fmt vet
	@echo "==> Running operator locally..."
	go run ./$(MAIN_SRC)

## help: Display available targets
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@sed -n 's/^##//p' $(MAKEFILE_LIST) | column -t -s ':'
