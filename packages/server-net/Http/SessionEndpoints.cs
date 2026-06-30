using System.Text.Json;
using CollabRelay.Relay;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace CollabRelay.Http;

/// <summary>
/// HTTP endpoints, mirroring the Node reference server (status codes, bodies,
/// auto-create, 400 paths) exactly.
/// </summary>
public static class SessionEndpoints
{
    private const string JsonContentType = "application/json; charset=utf-8";

    public static void MapSessionEndpoints(this IEndpointRouteBuilder app)
    {
        // POST /api/sessions  { schema? } -> 201 { sessionId }
        app.MapPost("/api/sessions", HandleCreate);

        // GET /api/sessions/{id} -> 200 { sessionId, schema, stack } | 400 invalid id
        app.MapGet("/api/sessions/{id}", HandleGet);

        // GET /health -> 200 { ok: true }
        app.MapGet("/health", HandleHealth);
    }

    private static async Task HandleCreate(HttpContext ctx, SessionManager sessions)
    {
        // Read the raw body. Empty/blank body is allowed and means "no schema"
        // (seed becomes {}). Only MALFORMED JSON yields 400. This mirrors Node's
        // readJsonBody: 0 bytes -> {}, blank -> {}, else JSON.parse (may throw).
        string body;
        using (var reader = new StreamReader(ctx.Request.Body, System.Text.Encoding.UTF8))
        {
            body = await reader.ReadToEndAsync(ctx.RequestAborted).ConfigureAwait(false);
        }

        JsonElement seed;
        if (string.IsNullOrWhiteSpace(body))
        {
            // No body -> seed {}.
            seed = EmptyObject();
        }
        else
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                // body.schema ?? {} — if the parsed body has a `schema` member, use
                // it verbatim; otherwise default to {} (matches createSession(body.schema)
                // where body.schema is undefined for a body like {} or "5").
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("schema", out var schemaEl)
                    && schemaEl.ValueKind != JsonValueKind.Null
                    && schemaEl.ValueKind != JsonValueKind.Undefined)
                {
                    seed = schemaEl.Clone(); // detach: stored long-lived in the session
                }
                else
                {
                    seed = EmptyObject();
                }
            }
            catch (JsonException ex)
            {
                // Malformed JSON -> 400 { error: <message> }, like the Node catch.
                await WriteJsonAsync(ctx, StatusCodes.Status400BadRequest,
                    JsonSerializer.SerializeToUtf8Bytes(
                        new ErrorResponse { Error = ex.Message }, JsonOptions.Default))
                    .ConfigureAwait(false);
                return;
            }
        }

        var session = sessions.Create(seed);
        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new CreateSessionResponse { SessionId = session.Id }, JsonOptions.Default);
        await WriteJsonAsync(ctx, StatusCodes.Status201Created, payload).ConfigureAwait(false);
    }

    private static async Task HandleGet(HttpContext ctx, SessionManager sessions, string id)
    {
        // Invalid id -> 400 BEFORE any create (matches Node's order).
        if (!SessionId.IsValid(id))
        {
            await WriteJsonAsync(ctx, StatusCodes.Status400BadRequest,
                JsonSerializer.SerializeToUtf8Bytes(
                    new ErrorResponse { Error = "invalid session id" }, JsonOptions.Default))
                .ConfigureAwait(false);
            return;
        }

        // Auto-create an empty session if missing, so any user-chosen URL is a
        // valid, joinable link.
        var session = sessions.GetOrCreate(id);
        // Body { sessionId, schema:<seed verbatim>, stack:{empty} } — built with
        // Utf8JsonWriter so the seed schema bytes pass through unchanged.
        var payload = session.SnapshotResponseJson();
        await WriteJsonAsync(ctx, StatusCodes.Status200OK, payload).ConfigureAwait(false);
    }

    private static async Task HandleHealth(HttpContext ctx)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new HealthResponse { Ok = true }, JsonOptions.Default);
        await WriteJsonAsync(ctx, StatusCodes.Status200OK, payload).ConfigureAwait(false);
    }

    // Writes a JSON body with an explicit Content-Length (like the Node server,
    // which sets Content-Length on every response). CORS headers are added by the
    // UseCors middleware, not here.
    private static async Task WriteJsonAsync(HttpContext ctx, int status, byte[] payload)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = JsonContentType;
        ctx.Response.ContentLength = payload.Length;
        await ctx.Response.Body.WriteAsync(payload, ctx.RequestAborted).ConfigureAwait(false);
    }

    private static JsonElement EmptyObject()
    {
        using var doc = JsonDocument.Parse("{}");
        return doc.RootElement.Clone();
    }
}
