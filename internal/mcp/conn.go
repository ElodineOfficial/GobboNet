// Package mcp lets characters call tools that MCP servers offer (1.8.0, #16).
//
// An MCP server is a program the user names in config.toml. GobboNet starts
// it on this PC (manager.go) and speaks the Model Context Protocol to it over
// the program's stdin and stdout: newline-delimited JSON-RPC 2.0. Of the
// protocol, v1 uses three requests -- initialize, tools/list and tools/call --
// and answers the server's ping. Resources, prompts, sampling, roots,
// elicitation and the remote HTTP transport are left out: each would be a new
// way for a program, or a page, to reach further than "run this tool".
//
// This is a small client of our own rather than the official Go SDK. The SDK's
// mcp package pulls jsonschema-go, segmentio/encoding, uritemplate, x/oauth2
// and x/time into an app that is meant to run offline, for three methods. Its
// place is if remote servers are ever added.
//
// Who may start a server, list its tools or call one is the HTTP layer's
// decision (internal/server/mcp.go). Which tools a character may call, and
// whether you are asked first, is the chat page's.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
)

// maxMessage bounds one message from a server. A tool result larger than this
// is not something a chat can use, and an unbounded line is a way to make
// GobboNet hold any amount of memory. A server that goes past it is stopped.
const maxMessage = 32 << 20

// JSON-RPC error codes this client sends.
const (
	codeMethodNotFound = -32601
)

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError is an error a server answered with.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("error %d", e.Code)
	}
	return e.Message
}

// errClosed is what a call gets when the connection ends under it.
var errClosed = errors.New("the connection to the server closed")

// conn is one JSON-RPC session over a server's stdio.
type conn struct {
	w   io.WriteCloser
	wmu sync.Mutex

	nextID atomic.Int64

	mu       sync.Mutex
	pending  map[int64]chan message
	closed   bool
	closeErr error
	done     chan struct{}

	// onNotify gets every notification from the server.
	onNotify func(method string, params json.RawMessage)
	// logf writes to the server's log file.
	logf func(format string, args ...any)
}

func newConn(r io.Reader, w io.WriteCloser, onNotify func(string, json.RawMessage), logf func(string, ...any)) *conn {
	if onNotify == nil {
		onNotify = func(string, json.RawMessage) {}
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	c := &conn{w: w, pending: map[int64]chan message{}, done: make(chan struct{}), onNotify: onNotify, logf: logf}
	go c.readLoop(r)
	return c
}

// Done closes when the connection has ended; Err then says why.
func (c *conn) Done() <-chan struct{} { return c.done }

func (c *conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closeErr
}

// close ends the connection: pending calls fail with err, and the server's
// stdin is closed, which is MCP's polite way to ask a stdio server to exit.
func (c *conn) close(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if err == nil {
		err = errClosed
	}
	c.closeErr = err
	pending := c.pending
	c.pending = map[int64]chan message{}
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
	close(c.done)
	c.w.Close()
}

// readLine reads one newline-terminated message, refusing more than
// maxMessage bytes.
func readLine(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(line)+len(chunk) > maxMessage {
			return nil, fmt.Errorf("the server sent a message over %d MB", maxMessage>>20)
		}
		line = append(line, chunk...)
		if err == nil {
			return line, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if len(line) > 0 && errors.Is(err, io.EOF) {
			return line, nil
		}
		return nil, err
	}
}

func (c *conn) readLoop(r io.Reader) {
	br := bufio.NewReaderSize(r, 64<<10)
	noise := 0
	for {
		line, err := readLine(br)
		if err != nil {
			if errors.Is(err, io.EOF) {
				err = errors.New("the server closed its output")
			}
			c.close(err)
			return
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var msgs []message
		switch line[0] {
		case '{':
			var m message
			if json.Unmarshal(line, &m) == nil {
				msgs = []message{m}
			}
		case '[':
			// A batch, which MCP before 2025-06-18 allowed.
			json.Unmarshal(line, &msgs) //nolint:errcheck // nil on failure, reported below
		}
		if len(msgs) == 0 {
			// Not JSON-RPC. The spec says a server must not write anything
			// else to stdout, but some print a banner; it goes to the log
			// rather than ending the session.
			if noise < 50 {
				c.logf("[gobbonet] ignored a line on stdout that is not MCP: %s", clip(string(line), 200))
			}
			noise++
			continue
		}
		for _, m := range msgs {
			c.dispatch(m)
		}
	}
}

func (c *conn) dispatch(m message) {
	switch {
	case m.Method != "" && len(m.ID) > 0:
		// A request from the server. ping must be answered; the rest are
		// features this client does not offer, and says so.
		resp := message{JSONRPC: "2.0", ID: m.ID}
		if m.Method == "ping" {
			resp.Result = json.RawMessage(`{}`)
		} else {
			resp.Error = &RPCError{Code: codeMethodNotFound, Message: "GobboNet does not offer " + m.Method}
		}
		c.write(resp) //nolint:errcheck // a failed write closes the connection
	case m.Method != "":
		c.onNotify(m.Method, m.Params)
	case len(m.ID) > 0:
		id, err := strconv.ParseInt(string(m.ID), 10, 64)
		if err != nil {
			return // not an id this client sent
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

func (c *conn) write(m message) error {
	m.JSONRPC = "2.0"
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	c.wmu.Lock()
	_, err = c.w.Write(raw)
	c.wmu.Unlock()
	if err != nil {
		c.close(fmt.Errorf("could not write to the server: %w", err))
	}
	return err
}

// notify sends a notification.
func (c *conn) notify(method string, params any) error {
	m := message{Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return err
		}
		m.Params = raw
	}
	return c.write(m)
}

// call sends a request and waits for its answer, decoding the result into
// out. When ctx ends first the server is told the request is cancelled, unless
// cancellable is false: initialize must not be cancelled.
func (c *conn) call(ctx context.Context, method string, params, out any, cancellable bool) error {
	id := c.nextID.Add(1)
	ch := make(chan message, 1)
	c.mu.Lock()
	if c.closed {
		err := c.closeErr
		c.mu.Unlock()
		return err
	}
	c.pending[id] = ch
	c.mu.Unlock()

	m := message{ID: json.RawMessage(strconv.FormatInt(id, 10)), Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			c.forget(id)
			return err
		}
		m.Params = raw
	}
	if err := c.write(m); err != nil {
		c.forget(id)
		return err
	}
	select {
	case <-ctx.Done():
		c.forget(id)
		if cancellable {
			c.notify("notifications/cancelled", map[string]any{"requestId": id, "reason": "GobboNet stopped waiting"}) //nolint:errcheck
		}
		return ctx.Err()
	case resp, ok := <-ch:
		if !ok {
			return c.Err()
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil {
			if len(resp.Result) == 0 {
				return fmt.Errorf("the server answered %s with no result", method)
			}
			if err := json.Unmarshal(resp.Result, out); err != nil {
				return fmt.Errorf("the server's answer to %s is not what MCP describes: %w", method, err)
			}
		}
		return nil
	}
}

func (c *conn) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// clip shortens s to at most n runes.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
