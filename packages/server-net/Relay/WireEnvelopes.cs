using System.Buffers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CollabRelay.Relay;

// ---------------------------------------------------------------------------
// Wire envelopes exchanged with the browser's raw WebSocket / fetch client.
//
// Byte-compatibility is the whole point of this file. Two rules:
//
//   1. The opaque `message` and the seed `schema` are forwarded VERBATIM. They
//      are captured as JsonElement (.Clone()'d when stashed long-lived) and
//      re-emitted with Utf8JsonWriter.WriteTo. They are NEVER round-tripped
//      through a typed model — doing so would reorder object members and
//      reformat numbers, corrupting transaction ids/values and silently
//      breaking undo/redo merging on the clients.
//
//   2. Every field name is pinned with [JsonPropertyName] and serialized with
//      JsonOptions.Default (PropertyNamingPolicy = null), so the wire format is
//      independent of framework defaults.
//
// Field list (case-sensitive): type, message, from, clientId, schema, stack,
// kind, cursor, entries, sessionId, ok, error.
// ---------------------------------------------------------------------------

/// <summary>
/// The shared undo/redo stack snapshot. The relay holds no SurveyJS model, so
/// every joiner gets an EMPTY stack and reconstructs an equivalent one locally
/// by applying the replayed log in order. Mirrors <c>ISyncStackSnapshot</c> on
/// the client: <c>{ "kind":"stack", "cursor":0, "entries":[] }</c>.
/// </summary>
public sealed record StackDto
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "stack";

    [JsonPropertyName("cursor")]
    public int Cursor { get; init; }

    // Must serialize as [] (never null). A non-null empty array guarantees that:
    // a null here would emit `"entries":null`, which the client/Node server do
    // not expect.
    [JsonPropertyName("entries")]
    public object[] Entries { get; init; } = Array.Empty<object>();

    /// <summary>The canonical empty stack: {"kind":"stack","cursor":0,"entries":[]}.</summary>
    public static readonly StackDto Empty = new()
    {
        Kind = "stack",
        Cursor = 0,
        Entries = Array.Empty<object>(),
    };
}

/// <summary>Body of <c>POST /api/sessions</c>: <c>{ schema? }</c>.</summary>
public sealed record CreateSessionRequest
{
    // Optional. When the body is empty/blank the whole object is treated as
    // absent and the seed becomes {} (handled in the endpoint, not here).
    [JsonPropertyName("schema")]
    public JsonElement? Schema { get; init; }
}

/// <summary>Body of the <c>201</c> response to <c>POST /api/sessions</c>.</summary>
public sealed record CreateSessionResponse
{
    [JsonPropertyName("sessionId")]
    public required string SessionId { get; init; }
}

/// <summary>Body of an <c>{ "error": ... }</c> response (e.g. 400).</summary>
public sealed record ErrorResponse
{
    [JsonPropertyName("error")]
    public required string Error { get; init; }
}

/// <summary>Body of <c>GET /health</c>: <c>{ "ok": true }</c>.</summary>
public sealed record HealthResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; } = true;
}

/// <summary>
/// Builders that emit wire frames with the opaque payload passed through
/// verbatim. These hand-roll the JSON with <see cref="Utf8JsonWriter"/> instead
/// of serializing a model so the embedded <c>schema</c>/<c>message</c> bytes are
/// preserved exactly.
/// </summary>
public static class WireFrames
{
    /// <summary>
    /// Build the <c>GET /api/sessions/{id}</c> response body:
    /// <c>{"sessionId":"…","schema":&lt;seed&gt;,"stack":{"kind":"stack","cursor":0,"entries":[]}}</c>.
    /// <paramref name="schema"/> is written verbatim.
    /// </summary>
    public static byte[] SnapshotResponse(string sessionId, JsonElement schema)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("sessionId", sessionId);
            w.WritePropertyName("schema");
            schema.WriteTo(w); // verbatim seed schema
            WriteEmptyStack(w);
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>
    /// Build the <c>init</c> frame:
    /// <c>{"type":"init","clientId":"…","schema":&lt;seed&gt;,"stack":{empty}}</c>.
    /// </summary>
    public static byte[] InitFrame(string clientId, JsonElement schema)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("type", "init");
            w.WriteString("clientId", clientId);
            w.WritePropertyName("schema");
            schema.WriteTo(w); // verbatim seed schema
            WriteEmptyStack(w);
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>
    /// Build a <c>sync</c> frame:
    /// <c>{"type":"sync","from":"&lt;from&gt;","message":&lt;verbatim&gt;}</c>.
    /// <paramref name="from"/> is a clientId for live relays, or the literal
    /// <c>"history"</c> for replayed log entries. <paramref name="message"/> is
    /// written verbatim — exactly the bytes the sender sent.
    /// </summary>
    public static byte[] SyncFrame(string from, JsonElement message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("type", "sync");
            w.WriteString("from", from);
            w.WritePropertyName("message");
            message.WriteTo(w); // verbatim opaque payload
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    // Writes the canonical empty stack object as a property named "stack":
    // "stack":{"kind":"stack","cursor":0,"entries":[]}
    private static void WriteEmptyStack(Utf8JsonWriter w)
    {
        w.WritePropertyName("stack");
        w.WriteStartObject();
        w.WriteString("kind", "stack");
        w.WriteNumber("cursor", 0);
        w.WriteStartArray("entries");
        w.WriteEndArray(); // empty -> []
        w.WriteEndObject();
    }
}

/// <summary>
/// Parses only what the relay needs from an inbound frame: the <c>type</c>
/// discriminator and the presence + raw bytes of <c>message</c>.
///
/// Deliberately does NOT parse numbers or any structure of the message body —
/// the message is opaque and must be appended/broadcast verbatim. The returned
/// <see cref="JsonElement"/> is a CLONE, detached from the parsed document, so
/// it remains valid after the document is disposed.
/// </summary>
public static class InboundFrame
{
    /// <summary>
    /// Returns true and sets <paramref name="message"/> (a detached clone) when
    /// the frame is a well-formed <c>{ "type":"sync", "message": &lt;any&gt; }</c>.
    /// Returns false for malformed JSON, a non-"sync" type, or a missing/null
    /// message — mirroring the Node guard
    /// <c>!parsed || parsed.type !== "sync" || !parsed.message</c>.
    /// </summary>
    public static bool TryParseSync(ReadOnlySpan<byte> utf8, out JsonElement message)
    {
        message = default;
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return false;

            if (!root.TryGetProperty("type", out var typeEl)
                || typeEl.ValueKind != JsonValueKind.String
                || typeEl.GetString() != "sync")
                return false;

            if (!root.TryGetProperty("message", out var msgEl))
                return false;

            // Mirror JS truthiness: `!parsed.message` is true for null. The Node
            // server drops null messages. (undefined cannot occur here since the
            // property is present.) Other falsy JSON values (false, 0, "") are
            // never produced by the client, but we only reject null to stay
            // faithful: a 0/""/false `message` would be `!message === true` in JS
            // and dropped, so reject those too for exact parity.
            switch (msgEl.ValueKind)
            {
                case JsonValueKind.Null:
                case JsonValueKind.Undefined:
                    return false;
                case JsonValueKind.False:
                    return false;
                case JsonValueKind.Number when msgEl.TryGetDouble(out var n) && n == 0:
                    return false;
                case JsonValueKind.String when msgEl.GetString()!.Length == 0:
                    return false;
            }

            // Clone so the element outlives `doc` (it is appended to the log).
            message = msgEl.Clone();
            return true;
        }
        catch (JsonException)
        {
            return false; // malformed JSON is silently dropped, like the Node server
        }
    }
}
