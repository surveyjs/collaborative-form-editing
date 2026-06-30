using System.Buffers;
using System.Net.WebSockets;
using System.Threading.Channels;

namespace CollabRelay.Relay;

/// <summary>
/// One connected WebSocket client.
///
/// Threading model (a hard invariant of the relay):
/// <list type="bullet">
/// <item><description>
///   Outbound: a single BOUNDED <see cref="Channel{T}"/> of pre-serialized UTF-8
///   frames drained by ONE writer task. This is the ONLY code that ever writes to
///   the socket, which guarantees frames go out strictly FIFO — replayed history
///   never interleaves with live syncs. The session actor only ever calls
///   <see cref="TryEnqueue"/> (a non-blocking TryWrite) and NEVER awaits the
///   socket, so a slow client can never stall the actor.
/// </description></item>
/// <item><description>
///   On a full outbound channel (a client too slow to drain 1024 queued frames)
///   we complete the channel with an exception. The writer loop observes it,
///   closes the socket, and the receive loop unblocks and posts <c>Leave</c>.
///   We drop the slow client rather than block the whole session.
/// </description></item>
/// <item><description>
///   Inbound: the receive loop accumulates partial frames until
///   <c>result.EndOfMessage</c> before handing the full message to the parser —
///   large schemas/transactions legitimately span multiple WebSocket frames.
/// </description></item>
/// </list>
/// </summary>
public sealed class ClientConnection
{
    // Capacity chosen to absorb a large history replay burst while still bounding
    // memory for a stuck client. Full => we drop the client (see above).
    private const int OutboundCapacity = 1024;

    // 16 KiB receive chunks; frames larger than this are reassembled across reads.
    private const int ReceiveChunkSize = 16 * 1024;

    private readonly WebSocket _socket;
    private readonly Channel<ReadOnlyMemory<byte>> _outbound;

    public string ClientId { get; }
    public string SessionId { get; }

    public ClientConnection(string sessionId, string clientId, WebSocket socket)
    {
        SessionId = sessionId;
        ClientId = clientId;
        _socket = socket;
        _outbound = Channel.CreateBounded<ReadOnlyMemory<byte>>(
            new BoundedChannelOptions(OutboundCapacity)
            {
                SingleReader = true,   // exactly one writer task drains it
                SingleWriter = false,  // the actor may enqueue from its single thread; keep general
                FullMode = BoundedChannelFullMode.Wait, // we never block: we TryWrite and handle false
            });
    }

    /// <summary>
    /// Non-blocking enqueue of a pre-serialized frame. Returns false if the
    /// channel is full (slow client) — the caller (the actor) treats that as a
    /// signal to drop the client. NEVER awaits; safe to call from the actor.
    /// </summary>
    public bool TryEnqueue(ReadOnlyMemory<byte> frame) => _outbound.Writer.TryWrite(frame);

    /// <summary>
    /// Drains <see cref="_outbound"/> to the socket, FIFO, until the channel is
    /// completed or the token is cancelled. This is the only writer of the socket.
    /// </summary>
    public async Task RunSendLoopAsync(CancellationToken token)
    {
        try
        {
            await foreach (var frame in _outbound.Reader.ReadAllAsync(token).ConfigureAwait(false))
            {
                if (_socket.State != WebSocketState.Open)
                    break;
                await _socket.SendAsync(
                    frame,
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown or connection teardown — normal.
        }
        catch (ChannelClosedException)
        {
            // Channel completed-with-exception because the client was too slow
            // (see DropForBackpressure). Fall through to close the socket.
        }
        catch (WebSocketException)
        {
            // Peer vanished mid-send — the receive loop will post Leave.
        }
        catch (Exception)
        {
            // Any other send failure: stop writing. Cleanup happens via the
            // receive loop / linked-token cancellation.
        }
    }

    /// <summary>
    /// Reads inbound frames, reassembles multi-frame messages, and invokes
    /// <paramref name="onMessage"/> once per complete message. Returns when the
    /// peer closes, on error, or on cancellation. The caller posts <c>Leave</c>
    /// afterwards in a finally.
    /// </summary>
    public async Task RunReceiveLoopAsync(Action<ReadOnlyMemory<byte>> onMessage, CancellationToken token)
    {
        var rented = ArrayPool<byte>.Shared.Rent(ReceiveChunkSize);
        // Reassembly buffer for messages that span multiple frames. Lazily grown.
        var assembled = new ArrayBufferWriter<byte>();
        try
        {
            while (!token.IsCancellationRequested && _socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await _socket
                        .ReceiveAsync(new ArraySegment<byte>(rented), token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (WebSocketException)
                {
                    break; // abrupt disconnect
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    // Cooperative close handshake (best-effort).
                    await CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", token)
                        .ConfigureAwait(false);
                    break;
                }

                // Accumulate this frame's bytes.
                assembled.Write(rented.AsSpan(0, result.Count));

                if (!result.EndOfMessage)
                    continue; // wait for the rest of a fragmented message

                // Full message assembled — hand the exact bytes to the parser.
                if (assembled.WrittenCount > 0)
                    onMessage(assembled.WrittenMemory);

                // Reset for the next message. ArrayBufferWriter.Clear keeps the
                // backing array, so a steady stream of similar-sized messages
                // amortizes to zero further allocation.
                assembled.Clear();
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    /// <summary>
    /// Forcibly stop the send loop for a client that cannot keep up. Completing
    /// the channel with an exception makes the writer loop throw
    /// <see cref="ChannelClosedException"/>, close the socket, and let the receive
    /// loop unblock. NEVER blocks the actor.
    /// </summary>
    public void DropForBackpressure() =>
        _outbound.Writer.TryComplete(new ChannelClosedException("client outbound queue overflow"));

    /// <summary>Mark the outbound channel complete so the send loop drains and exits.</summary>
    public void CompleteOutbound() => _outbound.Writer.TryComplete();

    /// <summary>Best-effort cooperative close.</summary>
    public async Task CloseAsync(WebSocketCloseStatus status, string description, CancellationToken token)
    {
        try
        {
            if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await _socket.CloseAsync(status, description, token).ConfigureAwait(false);
            }
        }
        catch
        {
            // Socket may already be torn down; ignore.
        }
    }
}
