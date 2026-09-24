package state

import (
	"net/http"
	"testing"
)

func TestWholeDocumentSeedCannotOverwriteConcurrentChanges(t *testing.T) {
	sp := statePath(t)
	first := send(t, sp, req{method: "PUT", target: "/state", body: seedDoc, headers: map[string]string{"If-None-Match": "*"}})
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body)
	}
	idx := body(t, send(t, sp, req{method: "GET", target: "/state/index"}))
	tag := idx["documentEtag"].(string)
	collision := send(t, sp, req{method: "PUT", target: "/state", body: `{"threads":[]}`, headers: map[string]string{"If-None-Match": "*"}})
	if collision.Code != http.StatusPreconditionFailed {
		t.Fatal("blind create replaced history", collision.Code)
	}
	changed := send(t, sp, req{method: "PUT", target: "/state/threads/new-device", body: `{"id":"new-device","messages":[]}`, headers: map[string]string{"If-None-Match": "*"}})
	if changed.Code != 200 && changed.Code != 201 {
		t.Fatal(changed.Code, changed.Body)
	}
	stale := send(t, sp, req{method: "PUT", target: "/state", body: `{"threads":[]}`, headers: map[string]string{"If-Match": tag}})
	if stale.Code != 412 {
		t.Fatal("stale snapshot replaced newer thread", stale.Code)
	}
	if got := send(t, sp, req{method: "GET", target: "/state/threads/new-device"}); got.Code != 200 {
		t.Fatal("new thread lost", got.Body)
	}
	idx = body(t, send(t, sp, req{method: "GET", target: "/state/index"}))
	allowed := send(t, sp, req{method: "PUT", target: "/state", body: `{"threads":[]}`, headers: map[string]string{"If-Match": idx["documentEtag"].(string)}})
	if allowed.Code != 200 {
		t.Fatal("explicit version-matched replacement refused", allowed.Body)
	}
}
