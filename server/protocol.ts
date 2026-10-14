/**
 * Wire protocol types — the TypeScript rendering of PROTOCOL.md.
 *
 * This file has ZERO imports on purpose: it is shared by the server and by all
 * client apps (each bundler compiles it independently), and it documents the
 * language-agnostic protocol. Journal records and survey JSON are `unknown`
 * everywhere — the server stores and forwards them without inspection.
 */

/** Room ids are chosen by clients and must match this pattern. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// HTTP

/** GET /api/rooms/:id → 200 */
export interface IRoomInfo {
    roomId: string;
    exists: true;
    clientCount: number;
    logLength: number;
}

/** POST /api/rooms request body. `seed` is the initial survey JSON (opaque). */
export interface ICreateRoomRequest {
    roomId: string;
    seed?: unknown;
}

/** POST /api/rooms → 201 */
export interface ICreateRoomResponse {
    roomId: string;
}

// ---------------------------------------------------------------------------
// WebSocket /ws/rooms/:id

/** client → server: "my local edit" — the server appends `payload` to the room log. */
export interface IAppendMsg {
    type: "append";
    payload: unknown;
}

/**
 * client → server: this client's FULL presence state (not a diff) — replaces
 * whatever the server stored for this client. Ephemeral: never enters the log.
 * Opaque to the server; the client-side shape is a creator-side convention
 * (survey-creator-core's CollaborationPlugin / IPresenceState). Full-state messages
 * make presence self-healing: any single message fully re-establishes the
 * participant. User identity is NOT in the state — the server stamps it onto
 * the relayed envelope (see IPresencePeerEntry).
 */
export interface IPresenceMsg {
    type: "presence";
    state: unknown;
}

export type ClientToServer = IAppendMsg | IPresenceMsg;

/**
 * One entry of the room log: an opaque journal record and its author. The
 * server stamps the author from the connection, as it does on presence, and
 * keeps it with the record - so a participant who joins later still learns
 * who made each edit, even after the author has left.
 */
export interface ILogEntry {
    /** The author's clientId. Per connection: a reload makes a new author. */
    from: string;
    /** The author's display name, as they connected with it (see PRESENCE_NAME_MAX). */
    name: string;
    payload: unknown;
}

/**
 * server → client, once right after connect: bootstrap state.
 * The client does `creator.JSON = seed`, then applies each entry's `payload`
 * in `log` array order.
 */
export interface IInitMsg {
    type: "init";
    clientId: string;
    seed: unknown;
    log: ILogEntry[];
}

/**
 * server → every client in the room except the author: a peer's edit - the
 * entry just appended to the log. The receiver applies `payload`; `from` and
 * `name` sign it (and `from` lets a client reject an accidental echo).
 */
export interface IRecordMsg extends ILogEntry {
    type: "record";
}

// ---------------------------------------------------------------------------
// Presence (ephemeral — never enters the room log)

/**
 * Presence carries no colors. Every client derives a peer's color itself from
 * the `clientId` (creator-core's `presenceColorSlot` -> a slot of the theme's
 * --sjs2-color-utility-user-*-color-N tokens), the same on every client and on
 * every surface; the server never assigns one.
 */

/** The server silently drops presence frames larger than this many bytes. */
export const PRESENCE_MAX_BYTES = 4096;

/**
 * Maximum display-name length; the server trims longer names. Names come from
 * the `?name=` query param of the WS connection URL (`/ws/rooms/:id?name=...`);
 * a missing/empty name becomes "Guest".
 */
export const PRESENCE_NAME_MAX = 32;

/**
 * Truncate to at most `max` Unicode code points. String#slice counts UTF-16
 * units and can cut a surrogate pair in half, leaving a lone surrogate that
 * strict JSON decoders reject; every name trim (server and clients) uses this.
 */
export function truncateCodePoints(s: string, max: number): string {
    return [...s].slice(0, max).join("");
}

/** One roster entry as the server knows it. `state` is opaque to the server. */
export interface IPresencePeerEntry {
    clientId: string;
    /** Display name from the connection URL's `?name=` param, sanitized by the server. */
    name: string;
    /** The last presence state this peer sent. */
    state: unknown;
}

/** server → every client except the author: a peer's presence changed. */
export interface IPresenceUpdateMsg {
    type: "presence";
    peer: IPresencePeerEntry;
}

/**
 * server → newcomer, immediately after `init` on the same connection:
 * everyone in the room who has sent presence so far.
 */
export interface IPresenceSyncMsg {
    type: "presence-sync";
    peers: IPresencePeerEntry[];
}

/** server → remaining clients: a client disconnected. */
export interface IPresenceLeaveMsg {
    type: "presence-leave";
    clientId: string;
}

export type ServerToClient =
    IInitMsg | IRecordMsg | IPresenceUpdateMsg | IPresenceSyncMsg | IPresenceLeaveMsg;
