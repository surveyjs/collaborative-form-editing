using System.Text.Json;

namespace CollabRelay.Relay;

/// <summary>
/// Events posted to a session's actor channel. The actor drains them on ONE
/// thread, so handling them is serial and lock-free by construction. This is
/// what makes "snapshot the log length AND register the client" atomic: it is a
/// single event handled in one step with nothing interleaving.
/// </summary>
public abstract record SessionEvent
{
    /// <summary>
    /// A client has connected. The actor, in one serial step: captures
    /// <c>N = log.Count</c>, registers <paramref name="Connection"/>, enqueues
    /// the <c>init</c> frame, then replays <c>log[0..N)</c> as history syncs.
    /// </summary>
    public sealed record Join(ClientConnection Connection) : SessionEvent;

    /// <summary>
    /// An inbound <c>{type:"sync",message}</c> from <paramref name="FromClientId"/>.
    /// The actor appends <paramref name="Message"/> to the log and broadcasts it
    /// to every client except the sender as <c>{type:"sync",from:clientId,message}</c>.
    /// </summary>
    public sealed record Sync(string FromClientId, JsonElement Message) : SessionEvent;

    /// <summary>
    /// A client disconnected (close or error). The actor removes it; if the
    /// session is now empty it arms the GC timer.
    /// </summary>
    public sealed record Leave(string ClientId) : SessionEvent;

    /// <summary>
    /// The GC timer fired. The actor deletes the session ONLY if it is still
    /// empty (a client may have rejoined while the timer was pending).
    /// <paramref name="Generation"/> guards against a stale timer from an earlier
    /// empty period firing after a rejoin/re-empty cycle.
    /// </summary>
    public sealed record GcFire(long Generation) : SessionEvent;
}
