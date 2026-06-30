using System.Text.RegularExpressions;

namespace CollabRelay.Relay;

/// <summary>
/// Validation for custom (user-chosen) session ids.
///
/// Matches the Node reference server's <c>SESSION_ID_RE</c> exactly:
/// URL-safe characters only, 1..128 chars. Any URL like <c>/my-survey</c> is a
/// valid, joinable session id; anything outside this set is rejected with 400
/// before a session is created and before the WebSocket is accepted.
/// </summary>
public static partial class SessionId
{
    // ^[A-Za-z0-9_-]{1,128}$ — identical to the Node and Go servers.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex Pattern();

    public static bool IsValid(string? id) =>
        !string.IsNullOrEmpty(id) && Pattern().IsMatch(id);
}
