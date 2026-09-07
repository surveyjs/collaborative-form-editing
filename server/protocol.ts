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
 * server → client, once right after connect: bootstrap state.
 * The client does `creator.JSON = seed`, then applies `log` in array order.
 */
export interface IInitMsg {
    type: "init";
    clientId: string;
    /**
     * This client's presence color slot, one of PRESENCE_COLOR_SLOTS.
     * Optional on the wire: a server without the presence extension omits it
     * and the client derives the slot from `clientId` instead.
     */
    colorIndex?: number;
    /** The slot's hex, `PRESENCE_PALETTE[colorIndex]`. See the palette's note. */
    color: string;
    seed: unknown;
    log: unknown[];
}

/**
 * server → every client in the room except the author: a peer's edit.
 * The receiver applies `payload`; `from` is the author's clientId
 * (defensive echo filtering + debugging).
 */
export interface IRecordMsg {
    type: "record";
    from: string;
    payload: unknown;
}

// ---------------------------------------------------------------------------
// Presence (ephemeral — never enters the room log)

/**
 * Presence colors. `colorIndex` is the wire value and the single source of
 * truth: it is the slot of the creator theme's
 * --sjs2-color-utility-user-{bg,fg-on,border}-color-N token family, so every UI
 * surface (avatars, focus rings, name badges, mouse cursors) paints the same
 * peer the same color.
 *
 * The slots a server may assign, in assignment order. Deliberately NOT 1..9:
 * two of the ten theme slots are unusable for a peer.
 *  - 0 is the neutral "unknown peer" gray, reserved as a client-side fallback.
 *  - 5 (#F9C50B yellow) is the only slot the theme pairs with a DARK foreground
 *    (--sjs2-color-utility-user-fg-on-color-5). The creator's name badge and
 *    cursor pill draw white text unconditionally, so a peer on slot 5 would be
 *    illegible there. One slot buys legibility on every surface.
 *
 * The server hands each connection the first slot in this set not held by
 * another client in the room, so colors are stable and collision-free per room.
 */
export const PRESENCE_COLOR_SLOTS: readonly number[] = [1, 2, 3, 4, 6, 7, 8, 9];

/**
 * The same palette flattened to raw hex and indexed BY SLOT (hence entries for
 * the never-assigned 0 and 5 too - `PRESENCE_PALETTE[slot]` must never go out
 * of range). Carried in the `color` field for clients that cannot resolve the
 * slot themselves.
 *
 * INVARIANT: these MUST stay equal to survey-core's
 * `baseTheme.cssVariables["--sjs2-color-utility-user-bg-color-N"]`. A themed
 * client paints the token; a client that cannot read it paints this array, and
 * the two must land on the same pixel. An e2e test enforces the equality.
 */
export const PRESENCE_PALETTE: readonly string[] = [
    "#808080", // slot 0 — unknown peer, never assigned
    "#1570EF", "#CA4FFB", "#19B35C", "#19B394", "#F9C50B",
    "#F99130", "#F1529C", "#02ADEB", "#4E6198"
];

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
    /**
     * Presence color slot, server-assigned - what every surface paints from.
     * Optional for the same reason as `IInitMsg.colorIndex`, and because this
     * type also describes what a client parses off the wire.
     */
    colorIndex?: number;
    /** The slot's hex, `PRESENCE_PALETTE[colorIndex]`. See the palette's note. */
    color: string;
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
