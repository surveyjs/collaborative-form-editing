// Package config loads server configuration from the environment, mirroring the
// knobs of the Node reference server (PORT/HOST/EMPTY_SESSION_TTL_MS) and adding
// the few extras the Go relay needs (static dir, read limit, origin policy).
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config is the fully-resolved runtime configuration.
type Config struct {
	// Host/Port the HTTP+WS server binds to. Defaults: localhost:8080.
	Host string
	Port int

	// EmptySessionTTL is how long an empty session lingers before the GC timer
	// deletes it. Default 30 min (1_800_000 ms), matching the Node server.
	EmptySessionTTL time.Duration

	// ClientDist is the absolute path to the built SPA (repo-root dist/client).
	// If <ClientDist>/index.html is missing the server runs API/WS-only.
	ClientDist string

	// ReadLimit is the per-connection max inbound frame size. Survey schemas and
	// transactions can far exceed the coder/websocket 32 KiB default, so we raise
	// it well above that (8 MiB) to avoid truncating legitimate payloads.
	ReadLimit int64

	// AllowAnyOrigin disables the WebSocket Origin check on Accept. The client is
	// same-origin and the HTTP API already sends Access-Control-Allow-Origin: *,
	// so by default we don't let an Origin mismatch reject a connection. Set
	// ALLOW_ANY_ORIGIN=false to re-enable the library's same-origin enforcement.
	AllowAnyOrigin bool
}

// Load reads the environment and applies defaults. It never fails; bad numeric
// values fall back to their defaults so the server always starts.
func Load() Config {
	cfg := Config{
		Host:            getenv("HOST", "localhost"),
		Port:            getenvInt("PORT", 8080),
		EmptySessionTTL: time.Duration(getenvInt64("EMPTY_SESSION_TTL_MS", 30*60*1000)) * time.Millisecond,
		ReadLimit:       getenvInt64("READ_LIMIT_BYTES", 8<<20),
		AllowAnyOrigin:  getenvBool("ALLOW_ANY_ORIGIN", true),
	}

	// Default to the repo-root dist/client, resolved relative to this binary's
	// working directory. When run from packages/server-go (e.g. `go run ./cmd/relay`),
	// "../../dist/client" resolves to the repo-root dist/client produced by
	// `npm run build:client`.
	dist := getenv("CLIENT_DIST", filepath.Join("..", "..", "dist", "client"))
	if abs, err := filepath.Abs(dist); err == nil {
		dist = abs
	}
	cfg.ClientDist = dist

	return cfg
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getenvInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func getenvBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
