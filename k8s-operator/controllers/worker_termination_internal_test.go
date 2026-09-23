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
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLastErrorLineRedactsCredentialsAndBoundsTheLine(t *testing.T) {
	cases := map[string]string{
		"github token":   "failed with ghp_abcdefghijklmnopqrstuvwxyz0123",
		"fine-grained":   "failed with github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
		"provider key":   "gateway rejected sk-or-v1-0123456789abcdef0123456789",
		"key assignment": `config {"api_key": "hunter2hunter2"}`,
		"jwt":            "token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
		"private key":    "-----BEGIN RSA PRIVATE KEY-----",
		"basic auth":     "upstream 401 Authorization: Basic dXNlcjpwYXNzd29yZA==",
		"digest auth":    "authorization=Digest username0123456789abcdef",
		"aws key id":     "s3 denied for AKIAIOSFODNN7EXAMPLE",
		"google key":     "maps key AIzaSyA1234567890abcdefghijklmnopqrstuv",
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			got := lastErrorLine("earlier line\n" + input + "\n")
			if !strings.Contains(got, "[REDACTED]") {
				t.Fatalf("lastErrorLine(%q) = %q, want the credential redacted", input, got)
			}
			for _, secret := range []string{"ghp_abc", "github_pat_11", "sk-or-v1", "hunter2", "eyJhbGci", "BEGIN RSA", "dXNlcjpwYXNzd29yZA", "username0123", "AKIAIOSFODNN7", "AIzaSyA123"} {
				if strings.Contains(got, secret) {
					t.Fatalf("lastErrorLine(%q) = %q still contains %q", input, got, secret)
				}
			}
		})
	}

	long := "error: " + strings.Repeat("é", 600) + "\x00\x1b[31m"
	got := lastErrorLine(long)
	if len(got) > maxTerminationMessageBytes || !utf8.ValidString(got) || strings.ContainsAny(got, "\x00\x1b") {
		t.Fatalf("bounded line = %d bytes valid=%v, want <= %d valid UTF-8 without control characters", len(got), utf8.ValidString(got), maxTerminationMessageBytes)
	}
	if lastErrorLine("\n \n\t\n") != "" {
		t.Fatal("blank message must record nothing")
	}
}
