// Command relay is a thin, byte-compatible WebSocket relay for the SurveyJS
// collaboration client. It holds NO SurveyJS model: per session it keeps only a
// seed schema, an append-only log of opaque sync messages, and the connected
// clients. A late joiner receives the seed + an empty stack, then a replay of
// the log, and reconstructs an equivalent state/stack locally.
//
// See ../../README.md and docs/relay-server-architecture.md for the contract.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/config"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/httpapi"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/session"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/static"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/ws"
)

func main() {
	cfg := config.Load()

	hub := session.NewHub(cfg.EmptySessionTTL, cfg.ReadLimit)
	api := httpapi.NewAPI(hub)
	wsHandler := ws.NewHandler(hub, cfg.AllowAnyOrigin)

	// Static SPA, or a JSON 404 catch-all if the bundle isn't built/present.
	staticHandler, served := static.Handler(cfg.ClientDist, httpapi.NotFoundJSON)

	router := &httpapi.Router{WS: wsHandler, Static: staticHandler, API: api}
	handler := router.Build()

	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	srv := &http.Server{
		Addr:    addr,
		Handler: handler,
		// BaseContext ties every request (including hijacked WebSockets) to a
		// context we cancel on shutdown, so read pumps blocked on Read unwind.
		BaseContext: func(net.Listener) context.Context { return rootCtx },
	}

	// Start listening before logging "listening" so a bind failure is reported.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("relay: cannot bind %s: %v", addr, err)
	}

	log.Printf("relay listening on http://%s", addr)
	if served {
		log.Printf("  serving client from %s", cfg.ClientDist)
	} else {
		abs, _ := filepath.Abs(cfg.ClientDist)
		log.Printf("  (client dist not found at %s -- API/WS only)", abs)
	}

	// Serve in the background so main can wait on a shutdown signal.
	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	// Wait for SIGINT/SIGTERM or a fatal serve error.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-stop:
		log.Printf("relay: received %s, shutting down", sig)
	case err := <-serveErr:
		log.Fatalf("relay: serve error: %v", err)
	}

	// Graceful shutdown:
	//  1) Stop accepting new connections and finish in-flight HTTP requests.
	//     http.Server.Shutdown does NOT close hijacked WebSocket connections,
	//     so their read pumps would block forever...
	//  2) ...therefore cancel the root context and close every WS connection
	//     ourselves, which unblocks the read pumps so their goroutines exit.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cancelRoot()       // cancel request contexts (best-effort wakeup)
	hub.CloseAll()     // explicitly close WS sockets so read pumps return

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("relay: graceful shutdown timed out: %v", err)
	}
	log.Print("relay: stopped")
}

// rootCtx is the base context for all requests; cancelRoot cancels it during
// shutdown so hijacked WebSocket read pumps (which use the request context)
// observe cancellation alongside the explicit socket close.
var rootCtx, cancelRoot = context.WithCancel(context.Background())
