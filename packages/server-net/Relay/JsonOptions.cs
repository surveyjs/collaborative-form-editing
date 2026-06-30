using System.Text.Encodings.Web;
using System.Text.Json;

namespace CollabRelay.Relay;

/// <summary>
/// Shared <see cref="JsonSerializerOptions"/> for every wire frame and HTTP body.
///
/// Byte-compatibility notes (why each setting matters):
/// <list type="bullet">
/// <item><description>
///   <c>PropertyNamingPolicy = null</c> — every property name is pinned explicitly
///   with <c>[JsonPropertyName]</c> on the DTOs, so we must NOT let STJ rewrite
///   them (the ASP.NET default is camelCase, which is already what we want for
///   these fields, but relying on it is fragile; pinning + null policy makes the
///   wire format independent of framework defaults).
/// </description></item>
/// <item><description>
///   <c>UnsafeRelaxedJsonEscaping</c> — the default encoder escapes characters
///   like <c>&lt;</c>, <c>&gt;</c>, <c>&amp;</c>, <c>+</c> and non-ASCII as
///   <c>\uXXXX</c>. The Node/Go reference servers emit them literally. Matching
///   that keeps schemas/messages containing HTML, emoji, or localized text
///   byte-identical to the reference servers.
/// </description></item>
/// <item><description>
///   The opaque <c>message</c> and seed <c>schema</c> are NEVER serialized through
///   these options as typed models — they are carried as <see cref="JsonElement"/>
///   and re-emitted verbatim via <see cref="Utf8JsonWriter"/>. These options only
///   format the envelope scaffolding around them.
/// </description></item>
/// </list>
/// </summary>
public static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new()
    {
        // Do NOT camelCase: names are fixed by [JsonPropertyName] on the DTOs.
        PropertyNamingPolicy = null,
        DictionaryKeyPolicy = null,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        // Compact output (no indentation), matching JSON.stringify on the Node side.
        WriteIndented = false,
    };
}
