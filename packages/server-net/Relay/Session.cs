using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace CollabRelay.Relay;

/// <summary>
/// A single collaboration session, implemented as an ACTOR.
///
/// All mutable state — the append-only <c>log</c>, the <c>clients</c> map, and
/// the GC bookkeeping — is touched ONLY by the single task draining
/// <see cref="_events"/>. Because that drain is serial, there are no locks and
/// the ordering guarantees fall out structurally:
///
///   * "snapshot the log length AND register the client" is atomic — it is one
///     <see cref="SessionEvent.Join"/> handled in one uninterrupted step, so no
///     <see cref="SessionEvent.Sync"/> can slip between the snapshot and the
///     registration.
///   * A sync that arrives after a join is appended (index >= N) and broadcast
///     to the new client exactly once; it is not part of the replayed snapshot.
///
/// The seed schema is stored as a detached <see cref="JsonElement"/> clone and
/// emitted verbatim; the log holds detached clones of each opaque message.
/// </summary>
public sealed class Session
{
    private readonly Channel<SessionEvent> _events;
    private readonly Func<Session, Task> _onEmptyExpired; // SessionManager.Remove(id, this)
    private readonly TimeSpan _emptyTtl;
    private readonly ILogger _logger;
    private readonly Task _drainTask;

    // ---- State owned exclusively by the drain loop (no external access) ----
    private readonly JsonElement _seedSchema;               // verbatim seed, detached clone
    private readonly List<JsonElement> _messageLog = new(); // ordered append-only; detached message clones, for replay
    private readonly Dictionary<string, ClientConnection> _clients = new();

    // GC generation: incremented every time the session transitions to empty.
    // A delayed GcFire only deletes if its generation still matches (i.e. the
    // session has stayed empty since the timer was armed).
    private long _gcGeneration;
    private CancellationTokenSource? _gcCts;

    public string Id { get; }

    public Session(
        string id,
        JsonElement seedSchema,
        TimeSpan emptyTtl,
        Func<Session, Task> onEmptyExpired,
        ILogger logger,
        CancellationToken hostStopping)
    {
        Id = id;
        // Caller is responsible for passing a detached clone; we keep it as-is.
        _seedSchema = seedSchema;
        _emptyTtl = emptyTtl;
        _onEmptyExpired = onEmptyExpired;
        _logger = logger;

        _events = Channel.CreateUnbounded<SessionEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,   // exactly one drain task
            SingleWriter = false,  // many connections post events
        });

        _drainTask = Task.Run(() => DrainAsync(hostStopping));
    }

    /// <summary>Post an event to the actor. Non-blocking (unbounded channel).</summary>
    public void Post(SessionEvent ev) => _events.Writer.TryWrite(ev);

    /// <summary>
    /// Build the <c>GET /api/sessions/{id}</c> snapshot body. The seed schema is
    /// immutable after construction, so reading it here without going through the
    /// actor is safe (it is never mutated by the drain loop).
    /// </summary>
    public byte[] SnapshotResponseJson() =>
        WireFrames.SnapshotResponse(Id, _seedSchema);

    /// <summary>Stop the actor (called on session deletion / shutdown).</summary>
    public void Complete() => _events.Writer.TryComplete();

    public Task Completion => _drainTask;

    // -----------------------------------------------------------------------
    // The single serial drain loop — the only mutator of log/clients.

    private async Task DrainAsync(CancellationToken hostStopping)
    {
        try
        {
            // hostStopping ends the loop on graceful shutdown; the finally then
            // completes every connection's outbound channel so send loops drain.
            await foreach (var ev in _events.Reader.ReadAllAsync(hostStopping).ConfigureAwait(false))
            {
                switch (ev)
                {
                    case SessionEvent.Join join:
                        HandleJoin(join.Connection);
                        break;
                    case SessionEvent.Sync sync:
                        HandleSync(sync.FromClientId, sync.Message);
                        break;
                    case SessionEvent.Leave leave:
                        HandleLeave(leave.ClientId);
                        break;
                    case SessionEvent.GcFire gc:
                        await HandleGcFireAsync(gc.Generation).ConfigureAwait(false);
                        break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Graceful shutdown (hostStopping) — not an error.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[session {SessionId}] drain loop crashed", Id);
        }
        finally
        {
            // On shutdown, signal every connection's send loop to drain & exit.
            foreach (var c in _clients.Values)
                c.CompleteOutbound();
            // Cancel + dispose any armed GC timer. _gcCts is only ever non-null
            // here when a timer is live (CancelGc nulls it after disposing), so
            // this cannot hit a disposed instance.
            try { _gcCts?.Cancel(); } catch (ObjectDisposedException) { }
            _gcCts?.Dispose();
            _gcCts = null;
        }
    }

    private void HandleJoin(ClientConnection conn)
    {
        // A join cancels any pending GC: the session is no longer empty. Bump
        // the generation so a GcFire already in flight becomes a no-op.
        CancelGc();

        // ATOMIC SNAPSHOT + REGISTER (this whole method runs uninterrupted):
        // capture N before registering so the replay reflects exactly the log as
        // it was at join time; any later Sync is appended at index >= N and
        // delivered live, exactly once.
        var n = _messageLog.Count;

        // 1) init frame (seed schema + empty stack).
        if (!conn.TryEnqueue(WireFrames.InitFrame(conn.ClientId, _seedSchema)))
        {
            // Should never happen on a fresh connection, but stay safe.
            conn.DropForBackpressure();
            return;
        }

        // 2) replay log[0..N) as history syncs, FIFO, before any live sync can be
        //    enqueued for this client (this method holds the actor).
        for (var i = 0; i < n; i++)
        {
            var frame = WireFrames.SyncFrame(WireConstants.FromHistory, _messageLog[i]);
            if (!conn.TryEnqueue(frame))
            {
                // Client cannot even absorb the replay — drop it; do not register.
                conn.DropForBackpressure();
                return;
            }
        }

        // 3) register only after init+replay are queued. From here on the client
        //    receives live syncs (index >= N) exactly once.
        _clients[conn.ClientId] = conn;
        _logger.LogInformation("[session {SessionId}] + client {ClientId} (now {Count})",
            Id, conn.ClientId, _clients.Count);
    }

    private void HandleSync(string fromClientId, JsonElement message)
    {
        // Append to the ordered log first (this defines global order), then
        // broadcast to everyone EXCEPT the sender.
        _messageLog.Add(message);

        if (_clients.Count == 0)
            return;

        byte[]? frame = null; // build once, reuse for all recipients
        foreach (var (otherId, peer) in _clients)
        {
            if (otherId == fromClientId)
                continue; // never echo a sync back to its sender
            frame ??= WireFrames.SyncFrame(fromClientId, message);
            if (!peer.TryEnqueue(frame))
            {
                // Slow peer: drop it. Its receive loop will unblock and post Leave,
                // which removes it and (if empty) arms GC. We do NOT block here.
                peer.DropForBackpressure();
            }
        }
    }

    private void HandleLeave(string clientId)
    {
        if (!_clients.Remove(clientId))
            return;
        _logger.LogInformation("[session {SessionId}] - client {ClientId} (now {Count})",
            Id, clientId, _clients.Count);

        if (_clients.Count == 0)
            ArmGc();
    }

    private async Task HandleGcFireAsync(long generation)
    {
        // Only delete if the session has stayed empty since the timer was armed.
        if (_clients.Count != 0 || generation != _gcGeneration)
            return;

        _logger.LogInformation(
            "[session {SessionId}] garbage-collected after {Ttl}ms idle",
            Id, (long)_emptyTtl.TotalMilliseconds);

        // Remove-if-still-this-instance from the manager, then complete the actor.
        await _onEmptyExpired(this).ConfigureAwait(false);
        Complete();
    }

    // -----------------------------------------------------------------------
    // GC timer: a cancellable Task.Delay that posts GcFire back to the actor, so
    // the empty-check runs ON the actor (no cross-thread access to _clients).

    private void ArmGc()
    {
        CancelGc(); // bump generation + cancel any prior timer
        var generation = _gcGeneration;
        var cts = new CancellationTokenSource();
        _gcCts = cts;
        var token = cts.Token;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(_emptyTtl, token).ConfigureAwait(false);
                Post(new SessionEvent.GcFire(generation));
            }
            catch (OperationCanceledException)
            {
                // Re-joined (or session torn down) before the TTL elapsed.
            }
        });
    }

    private void CancelGc()
    {
        // Every (re)arm/cancel bumps the generation so any in-flight GcFire from a
        // previous empty period is ignored when it finally lands on the actor.
        _gcGeneration++;
        _gcCts?.Cancel();
        _gcCts?.Dispose();
        _gcCts = null;
    }
}

/// <summary>Wire string constants shared across the relay.</summary>
public static class WireConstants
{
    /// <summary>
    /// The literal <c>from</c> value for replayed history syncs. The client only
    /// suppresses a sync whose <c>from</c> equals its own clientId (a UUID), so
    /// this tag never collides and replayed messages are always applied.
    /// </summary>
    public const string FromHistory = "history";
}
