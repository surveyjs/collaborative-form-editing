using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace CollabRelay.Relay;

/// <summary>
/// Owns the live set of sessions. Thread-safe via a
/// <see cref="ConcurrentDictionary{TKey,TValue}"/>; the per-session actors
/// serialize everything inside a session, so the manager only needs to make
/// create/get/remove atomic across sessions.
/// </summary>
public sealed class SessionManager
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly Config.ServerOptions _options;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<SessionManager> _logger;
    private readonly CancellationToken _hostStopping;

    public SessionManager(
        Config.ServerOptions options,
        ILoggerFactory loggerFactory,
        IHostApplicationLifetime lifetime)
    {
        _options = options;
        _loggerFactory = loggerFactory;
        _logger = loggerFactory.CreateLogger<SessionManager>();
        _hostStopping = lifetime.ApplicationStopping;
    }

    /// <summary>
    /// Create a brand-new session with an explicit seed schema (the
    /// <c>POST /api/sessions</c> path). The id is a freshly generated UUID, so a
    /// collision is effectively impossible; we still use the dictionary's atomic
    /// add to be safe.
    /// </summary>
    public Session Create(JsonElement seedSchema)
    {
        var id = NewSessionId();
        var session = NewSession(id, seedSchema);
        _sessions[id] = session;
        return session;
    }

    /// <summary>
    /// Get an existing session or create an empty one (seed <c>{}</c>). Used by
    /// both <c>GET /api/sessions/{id}</c> and the WebSocket connect path, so any
    /// user-typed id becomes a valid, joinable session on first touch.
    /// Atomic via <see cref="ConcurrentDictionary{TKey,TValue}.GetOrAdd(TKey,Func{TKey,TValue})"/>:
    /// concurrent first-touchers all observe the same instance.
    /// </summary>
    public Session GetOrCreate(string id)
    {
        return _sessions.GetOrAdd(id, key => NewSession(key, EmptySchema()));
    }

    public bool TryGet(string id, out Session session) =>
        _sessions.TryGetValue(id, out session!);

    /// <summary>
    /// Remove the session ONLY if the stored instance is still exactly
    /// <paramref name="instance"/>. This prevents a stale GC of one generation
    /// from deleting a newer session that happens to share the id (e.g. a rapid
    /// leave/rejoin that replaced the instance). Implemented with
    /// <c>TryRemove(KeyValuePair)</c>, which removes only on reference-equal value.
    /// </summary>
    public void Remove(string id, Session instance)
    {
        // ICollection<KeyValuePair<,>>.Remove on ConcurrentDictionary is the
        // "remove only if the current value equals this" atomic primitive.
        var removed = ((ICollection<KeyValuePair<string, Session>>)_sessions)
            .Remove(new KeyValuePair<string, Session>(id, instance));
        if (removed)
            _logger.LogDebug("[session {SessionId}] removed from manager", id);
    }

    private Session NewSession(string id, JsonElement seedSchema)
    {
        var logger = _loggerFactory.CreateLogger($"Session[{id}]");
        return new Session(
            id,
            seedSchema,
            _options.EmptySessionTtl,
            // onEmptyExpired: remove-if-still-this-instance. The Session calls this
            // from its own actor; Remove is itself thread-safe.
            session => { Remove(id, session); return Task.CompletedTask; },
            logger,
            _hostStopping);
    }

    // clientId / sessionId UUID format: lowercase "d" (no braces, no hyphens
    // stripped) — Guid.ToString("D"), e.g. "11112222-3333-4444-5555-666677778888".
    // Matches Node's randomUUID() shape, which the client treats as opaque.
    private static string NewSessionId() => Guid.NewGuid().ToString("D");

    // A detached empty object {} for the auto-create path. Parsed fresh each time
    // and cloned so it is a standalone, immutable JsonElement.
    private static JsonElement EmptySchema()
    {
        using var doc = JsonDocument.Parse("{}");
        return doc.RootElement.Clone();
    }
}
