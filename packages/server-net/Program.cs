using System.Net.WebSockets;
using CollabRelay.Config;
using CollabRelay.Http;
using CollabRelay.Relay;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// ===========================================================================
// CollabRelay — a thin, byte-compatible WebSocket relay for the SurveyJS
// collaboration app. No SurveyJS, no model: it forwards opaque messages and
// replays a per-session log to late joiners. Mirrors the Node reference server
// (packages/server-nodejs/index.ts) on the wire.
//
// RAW System.Net.WebSockets via ASP.NET Core (HttpContext.WebSockets.
// AcceptWebSocketAsync). NOT SignalR — SignalR's framing/handshake is
// incompatible with the browser's `new WebSocket(...)` client.
// ===========================================================================

var options = ServerOptions.FromEnvironment();

var builder = WebApplication.CreateBuilder(args);

// Bind exactly to HOST:PORT over plain HTTP (the client derives ws:// from the
// page origin; TLS, if any, is terminated by a proxy in front of this relay).
builder.WebHost.UseUrls($"http://{options.Host}:{options.Port}");

// Singletons: config + the session registry.
builder.Services.AddSingleton(options);
builder.Services.AddSingleton<SessionManager>();

// CORS: allow any origin/method/header, matching the Node server's
// `Access-Control-Allow-Origin: *` and the 204 preflight. The client may live
// on a different origin and talk to /api + /ws here.
const string CorsPolicy = "relay-cors";
builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p =>
    p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

var app = builder.Build();

app.UseCors(CorsPolicy);

// Enable WebSocket upgrades. KeepAliveInterval pings idle sockets so dead peers
// are detected; the relay itself stays passive otherwise.
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
});

// --- WebSocket branch: /ws/sessions/{id} -----------------------------------
// Registered before static serving so /ws is never swallowed by the SPA fallback.
app.Map("/ws/sessions/{id}", HandleWebSocket);

// --- HTTP API + health ------------------------------------------------------
app.MapSessionEndpoints();

// --- Static client (optional, gated by SERVE_CLIENT) ------------------------
// Registered AFTER /api and /ws so those are never swallowed by the SPA
// fallback. When SERVE_CLIENT is off (the default) the relay is pure API/WS.
if (options.ServeClient && Directory.Exists(options.ClientDist)
    && File.Exists(Path.Combine(options.ClientDist, "index.html")))
{
    var fileProvider = new PhysicalFileProvider(options.ClientDist);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });
    // SPA fallback: any unmatched GET serves index.html. Mapped last.
    app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = fileProvider });
    app.Logger.LogInformation("Serving client from {ClientDist}", options.ClientDist);
}
else if (options.ServeClient)
{
    app.Logger.LogWarning(
        "SERVE_CLIENT=true but no client build at {ClientDist} (index.html missing) — running API/WS only",
        options.ClientDist);
}

app.Logger.LogInformation("CollabRelay listening on http://{Host}:{Port}", options.Host, options.Port);

// Graceful shutdown: give in-flight connections a moment to close. Each
// connection links its token to ApplicationStopping (see HandleWebSocket), so
// cancellation propagates to every receive/send loop.
app.Lifetime.ApplicationStopping.Register(() =>
    app.Logger.LogInformation("Shutdown requested — closing sessions"));

await app.RunAsync();

// ===========================================================================
// WebSocket handler.

static async Task HandleWebSocket(HttpContext ctx, SessionManager sessions, IHostApplicationLifetime lifetime)
{
    var id = (string?)ctx.Request.RouteValues["id"];

    // 400 BEFORE AcceptWebSocketAsync if this is not a WS upgrade OR the id is
    // invalid. Setting StatusCode and returning here leaves the HTTP response
    // intact (the socket is never accepted), matching the Node upgrade handler
    // which writes "HTTP/1.1 400 Bad Request" before any handshake.
    if (!ctx.WebSockets.IsWebSocketRequest || !SessionId.IsValid(id))
    {
        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    // Auto-create on first connect so a freshly-typed URL just works.
    var session = sessions.GetOrCreate(id!);

    // Each connection gets a fresh clientId (UUID, lowercase "d" format).
    var clientId = Guid.NewGuid().ToString("D");

    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();

    // Link the connection's lifetime to host shutdown AND the request abort, so
    // graceful shutdown cancels every loop.
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        ctx.RequestAborted, lifetime.ApplicationStopping);
    var token = linkedCts.Token;

    var connection = new ClientConnection(id!, clientId, socket);

    // Post Join: the actor atomically snapshots the log, enqueues init + history
    // replay, and registers the client. We never touch session state directly.
    session.Post(new SessionEvent.Join(connection));

    // Run the send loop (drains the outbound queue) and the receive loop
    // concurrently. The receive loop parses each complete inbound message and
    // posts a Sync to the actor; the actor appends + broadcasts.
    var sendTask = connection.RunSendLoopAsync(token);
    var receiveTask = connection.RunReceiveLoopAsync(
        message =>
        {
            // Parse only `type` + presence of `message`; the message is opaque.
            if (InboundFrame.TryParseSync(message.Span, out var payload))
            {
                session.Post(new SessionEvent.Sync(clientId, payload));
            }
            // Non-sync / malformed frames are silently ignored (Node parity).
        },
        token);

    try
    {
        // The receive loop ends on peer close / error / shutdown. Once it ends,
        // the client is gone: tell the actor to remove it (and maybe arm GC),
        // then let the send loop drain and exit.
        await receiveTask.ConfigureAwait(false);
    }
    finally
    {
        session.Post(new SessionEvent.Leave(clientId));
        connection.CompleteOutbound();           // let the send loop finish
        await connection.CloseAsync(
            WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None)
            .ConfigureAwait(false);
        // Best-effort: wait briefly for the send loop to drain.
        try { await sendTask.ConfigureAwait(false); } catch { /* already handled */ }
    }
}
