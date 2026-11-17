package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

// Opt-in local TCP fanout + authenticated history reads. No TLS, E2EE decode,
// external network or LiveKit load: this is not a production capacity claim.
func TestServerEventFanoutLoad(t *testing.T) {
	if os.Getenv("PAWTALK_EVENT_LOAD") != "1" {
		t.Skip("opt-in: PAWTALK_EVENT_LOAD=1")
	}
	for _, size := range []int{100, 500, 1000} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			s := testMembershipStore(t)
			owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
			var channel string
			s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
			tokens := make([]string, size)
			for i := range tokens {
				root := sha256.Sum256([]byte(fmt.Sprintf("load-root-%d", i)))
				device := sha256.Sum256([]byte(fmt.Sprintf("load-device-%d", i)))
				signer := testMemberSigner{ed25519.NewKeyFromSeed(root[:]), ed25519.NewKeyFromSeed(device[:])}
				activateTestMember(t, s, signer, "member")
				tokens[i] = loginTestMember(t, s, signer).Token
			}
			server := httptest.NewServer(newMembershipHandler(s, config{}))
			defer server.Close()
			connections := make([]net.Conn, 0, size)
			defer func() {
				for _, c := range connections {
					c.Close()
				}
			}()
			type delivery struct {
				event, fetch time.Time
				err          error
			}
			done := make(chan delivery, size)
			var readers sync.WaitGroup
			readFrame := func(r *bufio.Reader) (byte, []byte, error) {
				var h [2]byte
				if _, err := io.ReadFull(r, h[:]); err != nil {
					return 0, nil, err
				}
				n := int(h[1] & 127)
				if n == 126 {
					var ext [2]byte
					if _, err := io.ReadFull(r, ext[:]); err != nil {
						return 0, nil, err
					}
					n = int(binary.BigEndian.Uint16(ext[:]))
				}
				if n > 2048 {
					return 0, nil, fmt.Errorf("frame bound")
				}
				p := make([]byte, n)
				_, err := io.ReadFull(r, p)
				return h[0] & 15, p, err
			}
			for _, token := range tokens {
				conn, err := net.Dial("tcp", server.Listener.Addr().String())
				if err != nil {
					t.Fatal(err)
				}
				connections = append(connections, conn)
				conn.SetDeadline(time.Now().Add(40 * time.Second))
				fmt.Fprintf(conn, "GET /api/v2/events HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", server.Listener.Addr(), token)
				r := bufio.NewReader(conn)
				res, err := http.ReadResponse(r, nil)
				if err != nil || res.StatusCode != 101 {
					t.Fatal("handshake", err)
				}
				_, initial, err := readFrame(r)
				if err != nil {
					t.Fatal(err)
				}
				var event memberEvent
				if json.Unmarshal(initial, &event) != nil || event.Type != "resync" {
					t.Fatal("catchup")
				}
				readers.Add(1)
				go func(token string, conn net.Conn, r *bufio.Reader) {
					defer readers.Done()
					for {
						op, p, err := readFrame(r)
						if err != nil {
							done <- delivery{err: err}
							return
						}
						if op == 9 {
							conn.Write([]byte{0x8a, 0x80, 0, 0, 0, 0})
							continue
						}
						if op != 1 {
							continue
						}
						var event memberEvent
						if json.Unmarshal(p, &event) != nil || event.Type != "chat" {
							continue
						}
						received := time.Now()
						req, _ := http.NewRequest("GET", server.URL+"/api/v2/channels/"+channel+"/messages?after=0&limit=1", nil)
						req.Header.Set("Authorization", "Bearer "+token)
						res, err := http.DefaultClient.Do(req)
						if err != nil {
							done <- delivery{err: err}
							return
						}
						io.Copy(io.Discard, res.Body)
						res.Body.Close()
						if res.StatusCode != 200 {
							err = fmt.Errorf("history %d", res.StatusCode)
						}
						done <- delivery{event: received, fetch: time.Now(), err: err}
						return
					}
				}(token, conn, r)
			}
			if _, err := s.postMessage(context.Background(), owner.Token, channel, testMessage('a')); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			s.publishChannel(channel, false)
			events, fetches := make([]time.Duration, 0, size), make([]time.Duration, 0, size)
			deadline := time.NewTimer(25 * time.Second)
			defer deadline.Stop()
			for range size {
				select {
				case d := <-done:
					if d.err != nil {
						t.Fatal(d.err)
					}
					events = append(events, d.event.Sub(start))
					fetches = append(fetches, d.fetch.Sub(start))
				case <-deadline.C:
					t.Fatal("fanout timeout")
				}
			}
			readers.Wait()
			sort.Slice(events, func(i, j int) bool { return events[i] < events[j] })
			sort.Slice(fetches, func(i, j int) bool { return fetches[i] < fetches[j] })
			t.Logf("clients=%d event_p50=%s event_p95=%s event_max=%s history_p95=%s history_max=%s", size, events[size/2], events[size*95/100], events[size-1], fetches[size*95/100], fetches[size-1])
		})
	}
}
