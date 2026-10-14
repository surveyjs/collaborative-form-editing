# Collaborative Form Editing Protocol

This document describes the server protocol used by the SurveyJS Creator collaboration plugin. The [Node.js server](server/) is a reference implementation with no SurveyJS dependency and can be ported to other languages.

## Room State

Each room holds its initial survey JSON (`seed`), an ordered list of edit records (`log`), and its connected clients. Each log entry keeps its record together with the record's author. The server stores and forwards the survey JSON and records without interpreting their contents.

The collaboration plugin turns local edits into records and applies records received from other participants. Applying the same initial survey and record sequence produces the same result, with the last change winning for each survey property.

## Create or Find a Room

Clients choose a room ID and can create a room through HTTP before connecting. The server assigns a separate client ID to each WebSocket connection.

| Identifier | Rules |
| --- | --- |
| Room ID | Must match `^[A-Za-z0-9_-]{1,64}$`. Invalid IDs receive HTTP `400` or a refused WebSocket upgrade. |
| Client ID | A unique string assigned by the server for each connection. Used in `init` and to identify the sender of relayed records. |
| Display name | Read from `?name=`, trimmed, and limited to 32 Unicode code points. Missing or empty names become `Guest`. |

The HTTP API lets clients check whether a room exists or create one with an initial survey:

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | `200 {"ok":true}` |
| `GET` | `/api/rooms/{roomId}` | `200 {roomId, exists:true, clientCount, logLength}`, `404 {exists:false}`, or `400` for an invalid ID |
| `POST` | `/api/rooms` | `201 {roomId}`, `409` if the room exists, or `400` for an invalid ID or malformed JSON |

To create a room, send `{ roomId, seed? }`. The `seed` is the initial survey JSON and defaults to `{}`. A `409` response leaves the existing room's seed and log unchanged; the client can join that room instead.

Responses use UTF-8 JSON. The reference server allows requests from any origin with `Access-Control-Allow-Origin: *`.

## Connect and Exchange Edits

Connect to `ws(s)://host/ws/rooms/{roomId}?name={displayName}`. Each connection represents one participant in one room. If the room does not exist, the server must create it with an empty seed (`{}`).

Each message is a JSON object sent as a text frame. Unknown message types must be ignored. The server silently ignores malformed JSON and `append` messages with a missing or null `payload`.

### Initial State

The server sends `init` immediately after connecting:

```json
{
  "type": "init",
  "clientId": "client-2",
  "seed": {},
  "log": [
    { "from": "client-1", "name": "Maria", "payload": { "...": "opaque record" } }
  ]
}
```

The client loads `seed` into the Creator, then applies the `payload` of every entry in `log` in array order. The example shows a room with one edit, made by another participant. Each entry has the same `from`, `name`, and `payload` fields as a [`record` message](#edit-records), so a client can show who made every edit in the log, including participants who have already left. The color fields belong to the optional presence extension and may be omitted by servers that do not support it.

> **Changed:** earlier versions of the protocol sent `log` as an array of bare records, without authors. A client written for that format applies each entry as a record and must be updated.

The server must send `init` before any `record` messages. Register the client and send the snapshot as one operation, so no edit is lost or delivered out of order between the snapshot and subsequent updates.

### Edit Records

When a local record is added or updated, the client sends an `append` message. The `payload` below is a placeholder for a plugin record:

```json
{ "type": "append", "payload": { "...": "opaque record" } }
```

The server adds the author's identity to the payload, appends the result to the room's log, and forwards it to every other participant:

```json
{ "type": "record", "from": "client-1", "name": "Maria", "payload": { "...": "opaque record" } }
```

Process each room's messages sequentially and broadcast records in log order. Never echo a record to its sender. As with presence, identity comes from the connection, not from the payload: `from` is the author's client ID, and `name` is the display name the author connected with. Clients use `from` to reject accidental echoes, and both fields to show who made the edit.

Keep the author with the log entry for as long as the room exists. A participant who joins later learns about earlier authors only from the log, because the participant list contains only connected clients. Client IDs are assigned per connection, so the same person reconnecting becomes a new author with the same name.

Append every record, including updated versions of earlier records. The plugin can combine rapid typing into one record and send it again when it changes. Do not deduplicate records or use a payload field as a unique log key: fields such as `seq` are local to each client. Applying the complete log in order handles these updates.

## Presence

Presence is an optional extension that shows participants' names, active tabs, selections, keyboard focus, and cursors. Clients and servers without this extension can still exchange edits by ignoring its message types.

### Send and Receive State

Clients send their full presence state each time, rather than partial changes:

```json
{ "type": "presence", "state": { "tab": "designer" } }
```

The plugin defines and interprets `state`. The server keeps only the latest state for each connected client and never adds presence to the edit log.

Editing locks also travel in `state`, so the server needs no lock messages. A participant who selects a question or panel in the designer sends `"lock": true` next to `sel`, and every other client then treats that element and its content as read-only. On the Logic tab, a participant who opens an existing rule sends the rule's key as `rule` together with `"lock": true`, and every other client then treats that rule, and the properties it sets, as read-only. Clients resolve locks themselves, from the same roster: when two participants lock overlapping elements at the same moment, the one with the smaller `clientId` keeps the lock. For this, the plugin needs its own `clientId` from `init`. Locks are advisory: the server still accepts every record.

To relay presence, the server adds the participant's identity and sends the result to every other client. Identity comes from the connection, not from the submitted state:

```json
{
  "type": "presence",
  "peer": {
    "clientId": "client-1",
    "name": "Maria",
    "state": { "tab": "designer" }
  }
}
```

The reference server silently drops presence messages larger than 4096 bytes. It also uses a token bucket per client, allowing 50 messages per second with a burst of 100.

### Join and Leave

If any connected clients have sent presence, send their latest states to a new participant immediately after `init`, on the same connection:

```json
{
  "type": "presence-sync",
  "peers": [
    { "clientId": "client-2", "name": "Bob", "state": {} }
  ]
}
```

When a participant disconnects, remove their stored presence and notify the remaining clients:

```json
{ "type": "presence-leave", "clientId": "client-1" }
```

Send this notification even if the participant never sent presence. Receivers ignore client IDs they do not know.

### Participant Colors

The server does not assign colors and sends none. Each client derives a participant's color from their `clientId` with the plugin's `presenceColorSlot`: FNV-1a over the ID, mapped onto the slots `1, 2, 3, 4, 6, 7, 8, 9` of the Creator theme's `--sjs2-color-utility-user-{bg,fg-on,border}-color-N` tokens. Slot `0` is reserved for unknown peers; slot `5` is excluded because its background is unsuitable for the white text on name badges and cursors.

Every client computes the same slot for the same `clientId`, so all clients and all parts of the UI paint a participant alike. Two participants can share a color, and a reconnect gets a new `clientId` and possibly a new color.

## Disconnect and Room Cleanup

The reference server pings each WebSocket every 30 seconds and terminates connections that do not respond. These connections produce the same `presence-leave` notification as a normal close. Browsers answer pings at the WebSocket layer, so clients do not need a separate timer to detect inactive peers.

When the last participant leaves, start a timer controlled by `EMPTY_ROOM_TTL_MS` (default: 30 minutes). A participant reconnecting before it expires cancels the timer. Otherwise, delete the room and its state.

A later connection to a deleted room creates a new room with an empty survey. The reference implementation stores rooms in memory, so restarting the server also clears them.
