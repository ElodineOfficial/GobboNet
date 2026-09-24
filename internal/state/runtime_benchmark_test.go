package state

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func BenchmarkRuntimeIndex(b *testing.B) {
	for _, n := range []int{10, 100} {
		for _, optimized := range []bool{false, true} {
			b.Run(fmt.Sprintf("%dMiB/new=%v", n, optimized), func(b *testing.B) {
				threads := make([]map[string]any, n)
				for i := range threads {
					threads[i] = map[string]any{"id": fmt.Sprint(i), "messages": []map[string]string{{"role": "user", "content": strings.Repeat("x", 1<<20)}}}
				}
				raw, _ := json.Marshal(map[string]any{"threads": threads})
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					d, e := parseDocument(raw)
					if e != nil {
						b.Fatal(e)
					}
					for _, t := range d.threads {
						threadID(t)
						messageCount(t)
						etagOf(t)
					}
					if optimized {
						if _, e = d.etag(); e != nil {
							b.Fatal(e)
						}
					} else {
						out := make(map[string]json.RawMessage)
						for k, v := range d.keys {
							out[k] = v
						}
						out["threads"], e = marshalJSON(d.threads)
						if e != nil {
							b.Fatal(e)
						}
						encoded, e := marshalJSON(out)
						if e != nil {
							b.Fatal(e)
						}
						etagOf(encoded)
					}
				}
			})
		}
	}
}
