namespace CollabRelay.Config;

/// <summary>
/// Fully-resolved runtime configuration, read from the environment.
///
/// Mirrors the knobs of the Node reference server (<c>packages/server-nodejs/index.ts</c>):
/// PORT / HOST / EMPTY_SESSION_TTL_MS, plus the static-serving switch.
/// <see cref="FromEnvironment"/> never throws: malformed numeric/boolean values
/// fall back to their defaults so the server always starts.
/// </summary>
public sealed record ServerOptions
{
    /// <summary>Host the HTTP+WS server binds to. Default: <c>localhost</c>.</summary>
    public required string Host { get; init; }

    /// <summary>Port the HTTP+WS server binds to. Default: <c>8080</c>.</summary>
    public required int Port { get; init; }

    /// <summary>
    /// How long an empty session lingers before its GC timer deletes it.
    /// Default 30 min (1_800_000 ms), matching the Node server.
    /// </summary>
    public required TimeSpan EmptySessionTtl { get; init; }

    /// <summary>
    /// When true, serve the built SPA from <see cref="ClientDist"/>. Default off:
    /// a language-independent relay does not host the client build; the client is
    /// usually served separately (or via a dev proxy). Gating static serving keeps
    /// the default deployment a pure API/WS relay.
    /// </summary>
    public required bool ServeClient { get; init; }

    /// <summary>
    /// Absolute path to the built SPA (repo-root <c>dist/client</c>). Default is
    /// <c>../../dist/client</c> resolved relative to the process working directory
    /// (which is <c>packages/server-net</c> under <c>dotnet run</c>), i.e. the
    /// repo-root <c>dist/client</c> produced by <c>npm run build:client</c>.
    /// Only consulted when <see cref="ServeClient"/> is true.
    /// </summary>
    public required string ClientDist { get; init; }

    public static ServerOptions FromEnvironment()
    {
        return new ServerOptions
        {
            Host = GetString("HOST", "localhost"),
            Port = GetInt("PORT", 8080),
            EmptySessionTtl = TimeSpan.FromMilliseconds(
                GetLong("EMPTY_SESSION_TTL_MS", 30 * 60 * 1000)),
            ServeClient = GetBool("SERVE_CLIENT", false),
            ClientDist = ResolveClientDist(),
        };
    }

    private static string ResolveClientDist()
    {
        // Default "../../dist/client" (repo-root dist/client, from packages/server-net).
        // Resolve to an absolute path so PhysicalFileProvider (which requires a
        // rooted path) is happy regardless of how the process was launched.
        var raw = GetString("CLIENT_DIST", Path.Combine("..", "..", "dist", "client"));
        try
        {
            return Path.GetFullPath(raw);
        }
        catch
        {
            return raw;
        }
    }

    // Treat an empty value the same as unset (matches the Node `?? default` and
    // the Go server's getenv, which both ignore empty strings).
    private static string GetString(string key, string fallback)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return string.IsNullOrEmpty(v) ? fallback : v;
    }

    private static int GetInt(string key, int fallback)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return int.TryParse(v, out var n) ? n : fallback;
    }

    private static long GetLong(string key, long fallback)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return long.TryParse(v, out var n) ? n : fallback;
    }

    private static bool GetBool(string key, bool fallback)
    {
        var v = Environment.GetEnvironmentVariable(key);
        if (string.IsNullOrEmpty(v)) return fallback;
        // Accept the common spellings: true/false, 1/0, yes/no, on/off.
        if (bool.TryParse(v, out var b)) return b;
        return v.Trim().ToLowerInvariant() switch
        {
            "1" or "yes" or "on" => true,
            "0" or "no" or "off" => false,
            _ => fallback,
        };
    }
}
