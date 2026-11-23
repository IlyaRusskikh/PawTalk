package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProtectedProofChunkTransportGoToNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	const lease = "1234567890abcdef1234567890abcdef"
	// The JSON prefix and padding leave exactly one UTF-8 byte in the first chunk.
	padding := protectedProofChunkBytes - len(`{"proof":"`) - 1
	payload := struct {
		Proof string `json:"proof"`
	}{Proof: strings.Repeat("a", padding) + "💬end"}
	var starts, continuations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/claim" || r.URL.Query().Get("scoped") != "1" {
			http.NotFound(w, r)
			return
		}
		request, err := readProtectedProofRequest(r, true, true)
		if err != nil || !request.enabled {
			http.Error(w, "missing negotiated proof request", http.StatusBadRequest)
			return
		}
		if request.offset == 0 {
			starts.Add(1)
		} else {
			continuations.Add(1)
		}
		var sent bool
		if err := request.write(w, &sent, payload, lease); err != nil {
			http.Error(w, "proof writer rejected the request", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const client = `
const assert = require('node:assert/strict');
const { proofPartBytes, readProtectedProofResponse } =
  require('../client/windows/electron/protected-proof-response.cjs');

(async () => {
  const { response, result } = await readProtectedProofResponse(
    headers => fetch(process.argv[1], { method: 'POST', headers }),
    true,
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('pawtalk-proof-lease'), process.argv[2]);
  assert.deepEqual(result, { proof: 'a'.repeat(proofPartBytes - '{"proof":"'.length - 1) + '💬end' });
})().catch(error => { console.error(error); process.exitCode = 1; });
`
	command := exec.CommandContext(ctx, node, "-e", client, server.URL+"/claim?scoped=1", lease)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Node proof reassembly failed: %v\n%s", err, output)
	}
	if starts.Load() != 1 || continuations.Load() != 1 {
		t.Fatalf("proof requests first=%d continuation=%d", starts.Load(), continuations.Load())
	}
}
