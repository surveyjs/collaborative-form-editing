/**
 * Framework-agnostic collaboration wiring: the creator's CollaborationPlugin ↔
 * WebSocket.
 *
 * This module has ZERO runtime imports on purpose. It is compiled
 * independently by four differently-built client apps (Vite×3 + Angular CLI);
 * importing "survey-creator-core" from here would resolve to a *second* copy
 * of the library and break survey-core's Serializer singleton. Instead the
 * caller creates the creator and the plugins from ITS OWN dependency copy and
 * injects them (structural typing below). Type-only imports are fine — they
 * are erased at build.
 *
 * Usage (identical in every client):
 *   const creator = new SurveyCreator(...);            // framework-specific
 *   const collab = new CollaborationPlugin(creator, { roomId });
 *   creator.addPlugin("collaboration", collab);
 *   const connection = connectCollab({ creator, collab, roomId });
 *
 * Presence responsibilities are split: the plugin determines the state
 * (focus/selection/cursor) and renders remote peers; this module only
 * moves the opaque state over the wire (send-throttled) and routes the
 * server's user-stamped envelopes ({clientId, name, colorIndex, color, state})
 * into the plugin's roster. It also owns the one thing the plugin cannot do
 * for itself: turning the server's color slot into pixels on BOTH surfaces —
 * the avatar chips and the focus rings/badges/cursors (see "Peer colors"
 * below). Liveness is the server's job: its WS ping/pong keepalive
 * detects dead connections and broadcasts the leave, so this module does NOT
 * time out peers itself (a timer-based sweep would falsely drop an idle peer
 * whose background tab throttled its heartbeat).
 */
import type { IPresencePeerEntry } from "../server/protocol";

/** Structural mirror of survey-creator-core's EventBase — only what we use. */
export interface IJournalEvent {
    add(handler: (sender: unknown, options: { record: unknown }) => void): void;
    remove(handler: (sender: unknown, options: { record: unknown }) => void): void;
}

/** The journal half of the CollaborationPlugin surface we use. */
export interface IJournalPluginLike {
    onRecordAdded: IJournalEvent;
    onRecordChanged: IJournalEvent;
    apply(input: unknown): unknown;
}

/**
 * Structural mirror of survey-creator-core's IJournalRecord — the shape a
 * "version history" view needs. Kept local (not imported) per the zero-runtime
 * -imports rule; the fields match journal-record.ts (`op` is the numeric
 * JournalOp, `payload` carries the change's target/value).
 */
export interface IRoomChange {
    seq: number;
    timestamp: number;
    op: number;
    payload: any;
}

export interface IPresenceEvent {
    add(handler: (sender: unknown, options: unknown) => void): void;
    remove(handler: (sender: unknown, options: unknown) => void): void;
}

/** The presence half of the CollaborationPlugin surface we use. */
export interface IPresencePluginLike {
    onStateChanged: IPresenceEvent;
    /** Fires on every roster mutation (setPeers/upsertPeer/removePeer/clearPeers). */
    onPeersChanged: IPresenceEvent;
    getState(): unknown;
    readonly peers: ReadonlyMap<string, IPresencePeerEntry>;
    setPeers(entries: IPresencePeerEntry[]): void;
    upsertPeer(entry: IPresencePeerEntry): void;
    removePeer(clientId: string): void;
    clearPeers(): void;
}

/**
 * Structural mirror of the bar's ICollabParticipant. `colorIndex` is the avatar
 * chips' ONLY color input - the strip derives the CSS class
 * `svc-collab-bar__avatar--color-N` from it and never renders `color` (which
 * only participates in the bar's re-render signature).
 */
export interface ICollabParticipant {
    id: string;
    name: string;
    color: string;
    colorIndex?: number;
    tab: string;
}

/** The collaboration-strip half of the plugin surface we drive. */
export interface ICollabBarPluginLike {
    setParticipants(users: ICollabParticipant[]): void;
}

/** Structural mirror of the creator — its survey JSON plus its themed root. */
export interface ICreatorLike {
    JSON: unknown;
    /**
     * The creator's own root node, set by the framework wrapper on mount. It
     * carries `sd-theme-root`, and creator-core injects the base theme's CSS
     * variables into a <style> inside it — so this is where the
     * --sjs2-color-utility-user-* tokens resolve. Undefined before mount:
     * connectCollab() runs before render() in three of the four clients.
     */
    readonly rootElement?: HTMLElement | null;
}

export type CollabStatus = "connecting" | "connected" | "closed";

/**
 * The creator's CollaborationPlugin plays all three roles: it owns the journal,
 * the presence roster and the collaboration strip, and exposes each surface
 * directly.
 */
export type ICollabPluginLike = IJournalPluginLike & IPresencePluginLike & ICollabBarPluginLike;

export interface ICollabOptions {
    creator: ICreatorLike;
    collab: ICollabPluginLike;
    roomId: string;
    /** Override the WS origin, e.g. "ws://localhost:8080". Default: same origin. */
    wsBase?: string;
    onStatus?: (status: CollabStatus) => void;
    /**
     * Display name sent to the server in the connection URL (?name=); the
     * server stamps it onto every relayed peer envelope. Default: getDisplayName().
     */
    name?: string;
    /** The peer roster changed (join/update/leave). Excludes self. */
    onPresence?: (peers: ReadonlyMap<string, IPresencePeerEntry>) => void;
    /**
     * The room's change history grew or a record was updated in place. Carries
     * every journal record the room has seen — the init log (history to date),
     * remote records, and this client's local edits — in arrival order. Backs
     * the "Show Version History" view. Not derivable from `collab.records`,
     * which holds this client's LOCAL edits only (applied remote/init records
     * are suppressed from it via `recorder.isApplying`).
     */
    onHistoryChanged?: (changes: ReadonlyArray<IRoomChange>) => void;
}

export interface ICollabConnection {
    dispose(): void;
}

// ---------------------------------------------------------------------------
// Peer colors: one server slot -> every surface
//
// The creator paints a peer from TWO independent inputs, and nothing inside it
// ties them together:
//   - the avatar chips read `ICollabParticipant.colorIndex` (a theme
//     user-color slot) and paint it through a CSS class;
//   - the focus rings, name badges and mouse cursors read the roster entry's
//     `color` and paint it directly.
// The roster whitelists `{clientId, name, color, state}`, so a slot cannot
// travel that way, and with `colorIndex` absent the strip falls back to hashing
// the clientId - which is how one peer ends up two colors.
//
// This module is where the server's slot becomes pixels for both halves: it
// resolves the slot to a literal color and writes it into `color` (rings,
// badges, cursors), and re-pushes the roster with `colorIndex` (chips).

/**
 * Local copy of creator-core's `presenceColorSlot` (this file's
 * zero-runtime-imports rule forbids importing it).
 *
 * It MUST stay byte-identical, including the range 0..9 with the reserved gray
 * 0 and the illegible 5: when the wire carries no `colorIndex`, the strip falls
 * back to the creator's own copy for the chip class, so any "improvement" here
 * would put the chip and the ring on different slots - the exact split this
 * module exists to close.
 */
function hashColorSlot(clientId: string): number {
    const id = typeof clientId === "string" ? clientId : "";
    // FNV-1a, 32-bit. Math.imul keeps the multiply from losing precision.
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
    }
    return Math.abs(hash % 10);
}

/**
 * The light theme's user-color slots, for a client that cannot read the tokens
 * (nothing mounted yet, or a non-DOM host). Same values as the server's
 * PRESENCE_PALETTE and survey-core's baseTheme - see the palette's invariant
 * note in server/protocol.ts.
 */
const USER_COLOR_FALLBACK: readonly string[] = [
    "#808080", "#1570EF", "#CA4FFB", "#19B35C", "#19B394",
    "#F9C50B", "#F99130", "#F1529C", "#02ADEB", "#4E6198"
];

const USER_COLOR_TOKEN = "--sjs2-color-utility-user-bg-color-";

/** Per-peer color bookkeeping for one connection. */
interface IPeerColors {
    /** Record the slot an envelope carried (or derive one from the id). */
    remember(clientId: string, colorIndex?: number): void;
    slotOf(clientId: string): number;
    /** The literal color this peer is painted with, frozen on first call. */
    colorOf(clientId: string, wireColor?: string): string;
    forget(clientId: string): void;
    /** Drop everyone outside `live` (a roster replacement). */
    retain(live: ReadonlySet<string>): void;
    clear(): void;
}

function createPeerColors(creator: ICreatorLike): IPeerColors {
    const slots = new Map<string, number>();
    // clientId -> the color it was FIRST painted with (see colorOf).
    const painted = new Map<string, string>();
    const bySlot = new Map<number, string>();
    // The root `bySlot` was read from; a different one invalidates the cache.
    let readFrom: HTMLElement | null = null;

    const themeRoot = (): HTMLElement | null => {
        // The creator exposes its root only once the framework mounts it.
        // querySelector is the fallback for a host that passes a bare shim;
        // BOTH classes are required so it can never match the detached
        // .sd-theme-root probe creator-core appends to <body> when it
        // calculates theme variables.
        const root = creator.rootElement
            ?? (typeof document !== "undefined"
                ? document.querySelector<HTMLElement>(".svc-creator.sd-theme-root")
                : null)
            ?? null;
        if (root !== readFrom) {
            bySlot.clear();
            readFrom = root;
        }
        return root;
    };

    /** The slot's color as the LIVE theme renders it, or "" if unavailable. */
    const fromTheme = (slot: number): string => {
        const cached = bySlot.get(slot);
        if (cached !== undefined) return cached;
        const root = themeRoot();
        if (!root || typeof getComputedStyle !== "function") return "";
        // A custom property's computed value is already var()-substituted, so
        // this is the final literal - which is what the badges and cursors
        // need: they live in a layer on <body>, outside .sd-theme-root, where a
        // var() reference would not resolve.
        const value = getComputedStyle(root).getPropertyValue(USER_COLOR_TOKEN + slot).trim();
        if (!value || value.indexOf("var(") >= 0) return ""; // never cache a miss
        bySlot.set(slot, value);
        return value;
    };

    const slotOf = (clientId: string): number => {
        const slot = slots.get(clientId);
        return slot !== undefined ? slot : hashColorSlot(clientId);
    };

    return {
        remember(clientId: string, colorIndex?: number): void {
            if (typeof colorIndex === "number" && isFinite(colorIndex)) {
                slots.set(clientId, Math.trunc(colorIndex));
            } else if (!slots.has(clientId)) {
                slots.set(clientId, hashColorSlot(clientId));
            }
        },
        slotOf,
        colorOf(clientId: string, wireColor?: string): string {
            // Frozen per clientId on first resolution, mirroring the overlay:
            // it bakes the cursor arrow's fill and the pill's background into
            // per-client artifacts at first sighting and never refreshes them.
            // A slot is fixed for a connection's whole life (the server assigns
            // once, clientIds are per-connection), so freezing the resolved
            // color keeps ring, badge and cursor identical for good - and keeps
            // the participant list byte-stable across presence ticks, which is
            // what stops the strip from rebuilding its chips on every frame.
            const already = painted.get(clientId);
            if (already !== undefined) return already;
            const slot = slotOf(clientId);
            const color = fromTheme(slot) || wireColor || USER_COLOR_FALLBACK[slot] || USER_COLOR_FALLBACK[0];
            painted.set(clientId, color);
            return color;
        },
        forget(clientId: string): void {
            slots.delete(clientId);
            painted.delete(clientId);
        },
        retain(live: ReadonlySet<string>): void {
            for (const id of [...slots.keys()]) if (!live.has(id)) slots.delete(id);
            for (const id of [...painted.keys()]) if (!live.has(id)) painted.delete(id);
        },
        clear(): void {
            slots.clear();
            painted.clear();
            bySlot.clear();
        }
    };
}

/** Outgoing presence is coalesced to at most one message per this interval. */
const PRESENCE_SEND_MS = 40;

export function connectCollab(opts: ICollabOptions): ICollabConnection {
    const { creator, roomId } = opts;
    // The two roles the one plugin plays, named apart for readability below.
    const plugin: IJournalPluginLike = opts.collab;
    const presence: IPresencePluginLike = opts.collab;
    const bar: ICollabBarPluginLike = opts.collab;
    const colors = createPeerColors(creator);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const base = opts.wsBase ?? `${proto}//${location.host}`;
    const name = opts.name ?? getDisplayName();
    const ws = new WebSocket(`${base}/ws/rooms/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name)}`);
    opts.onStatus?.("connecting");

    // Gate outgoing records until the init bootstrap has been applied.
    let ready = false;

    // --- room change history (Show Version History) ----------------------------
    // Accumulated from all three record sources; onRecordChanged mutates entries
    // in place (coalescing), so we keep references and just re-emit.
    const history: IRoomChange[] = [];
    const emitHistory = (): void => opts.onHistoryChanged?.(history);
    const recordHistory = (record: unknown): void => {
        if (!!record && typeof record === "object") history.push(record as IRoomChange);
    };

    // --- presence: own state (owned by the plugin, only shipped from here) ----
    let clientId: string | null = null;

    let lastSentAt = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const sendPresenceNow = (): void => {
        sendTimer = undefined;
        if (!ready || ws.readyState !== WebSocket.OPEN) return;
        lastSentAt = Date.now();
        ws.send(JSON.stringify({ type: "presence", state: presence.getState() }));
    };
    const schedulePresenceSend = (): void => {
        if (sendTimer !== undefined) return;
        const elapsed = Date.now() - lastSentAt;
        if (elapsed >= PRESENCE_SEND_MS) sendPresenceNow();
        else sendTimer = setTimeout(sendPresenceNow, PRESENCE_SEND_MS - elapsed);
    };
    const stateChanged = (): void => schedulePresenceSend();
    presence.onStateChanged.add(stateChanged);

    // --- presence: peers (roster lives in the plugin) --------------------------
    // The plugin fires onPeersChanged on every roster mutation — that single
    // subscription is the caller's notification path; no manual bookkeeping.
    // Both halves of a peer's color are pushed from here: `colorIndex` for the
    // avatar chips, and the resolved `color` (written on ingest) for the rings,
    // badges and cursors.
    //
    // Peer colors are frozen per clientId, so this list is byte-stable across
    // presence ticks that change no roster field - the strip's own signature
    // guard then skips the rebuild, and an open roster popup survives a peer's
    // mouse move.
    const peersChanged = (): void => {
        const participants: ICollabParticipant[] = [];
        presence.peers.forEach((peer) => {
            participants.push({
                id: peer.clientId,
                name: peer.name,
                // Already the resolved color - we rewrote it on ingest. The
                // slot comes from our own map because the roster drops it.
                color: peer.color,
                colorIndex: colors.slotOf(peer.clientId),
                tab: (peer.state as { tab?: string } | null)?.tab ?? ""
            });
        });
        bar.setParticipants(participants);
        opts.onPresence?.(presence.peers);
    };
    presence.onPeersChanged.add(peersChanged);

    // Take over the roster -> strip push entirely.
    //
    // The plugin wires its own handler on this event in its constructor, which
    // pushes a roster WITHOUT colorIndex (its mapper copies {id,name,color,tab}
    // and drops the slot, so the strip falls back to hashing the clientId).
    // Leaving that handler in place does not just paint the wrong slot for an
    // instant - the two pushes carry different signatures, so they alternate
    // and NEITHER is ever a no-op: every presence tick, a peer's every mouse
    // move, would rebuild the chips twice. Detaching it makes ours the only
    // writer and restores the strip's signature guard.
    //
    // `peersChangedHandler` is private, so this is deliberately defensive: if a
    // future version renames it we simply keep both pushes - the colors stay
    // correct, only the churn comes back.
    const pluginRosterPush = (opts.collab as { peersChangedHandler?: (...args: any[]) => void })
        .peersChangedHandler;
    if (typeof pluginRosterPush === "function") {
        presence.onPeersChanged.remove(pluginRosterPush);
        // The plugin primed the strip in its constructor with the (then empty)
        // roster; ours is now the only source, so re-push what is there.
        peersChanged();
    }

    const isPeerEntry = (entry: IPresencePeerEntry | undefined): entry is IPresencePeerEntry =>
        !!entry && entry.clientId !== clientId && !!entry.state;

    // The roster keeps only `{clientId, name, color, state}`, and that single
    // `color` field is what paints the focus ring (an inline
    // --collab-peer-color on the real creator node), the name badge
    // (background) and the mouse cursor (svg fill + pill). So the slot's
    // resolved color has to ride in on it - as a literal, since two of those
    // three are drawn in a layer outside the theme root.
    const themed = (entry: IPresencePeerEntry): IPresencePeerEntry => {
        colors.remember(entry.clientId, entry.colorIndex);
        return { ...entry, color: colors.colorOf(entry.clientId, entry.color) };
    };

    ws.addEventListener("message", (ev) => {
        let msg: any;
        try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "init") {
            clientId = typeof msg.clientId === "string" ? msg.clientId : null;
            // Fresh socket → fresh roster; a presence-sync follows on this socket.
            // Slots go with it: the server assigns them per connection.
            presence.clearPeers();
            colors.clear();
            // Bootstrap order matters: seed does NOT produce journal records,
            // then the log replays in server order (apply() suppresses echo).
            creator.JSON = msg.seed ?? {};
            if (Array.isArray(msg.log) && msg.log.length > 0) {
                plugin.apply(msg.log);
                for (const record of msg.log) recordHistory(record);
                emitHistory();
            }
            ready = true;
            opts.onStatus?.("connected");
            // Announce ourselves so existing occupants see the newcomer at once.
            schedulePresenceSend();
        } else if (msg.type === "record") {
            plugin.apply(msg.payload);
            recordHistory(msg.payload);
            emitHistory();
        } else if (msg.type === "presence-sync") {
            const peers = Array.isArray(msg.peers) ? (msg.peers as IPresencePeerEntry[]).filter(isPeerEntry) : [];
            // A sync REPLACES the roster, so anyone missing from it is gone.
            colors.retain(new Set(peers.map((peer) => peer.clientId)));
            presence.setPeers(peers.map(themed));
        } else if (msg.type === "presence") {
            if (isPeerEntry(msg.peer)) presence.upsertPeer(themed(msg.peer));
        } else if (msg.type === "presence-leave") {
            colors.forget(msg.clientId);
            presence.removePeer(msg.clientId);
        }
    });

    const sendRecord = (_: unknown, options: { record: unknown }): void => {
        if (ready && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "append", payload: options.record }));
        }
    };
    // A local edit: ship it and add it to the room history.
    const onLocalRecordAdded = (sender: unknown, options: { record: unknown }): void => {
        sendRecord(sender, options);
        recordHistory(options.record);
        emitHistory();
    };
    // A coalesced record was updated in place — re-send it; the server appends
    // it as a new log entry and replay converges (last write wins). The history
    // entry is the same object reference, already updated — just re-emit.
    const onLocalRecordChanged = (sender: unknown, options: { record: unknown }): void => {
        sendRecord(sender, options);
        emitHistory();
    };
    plugin.onRecordAdded.add(onLocalRecordAdded);
    plugin.onRecordChanged.add(onLocalRecordChanged);

    // The plugins outlive the socket — unhook every handler or each reconnect
    // stacks another dead closure retaining the old WebSocket.
    let disposed = false;
    const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        if (sendTimer !== undefined) clearTimeout(sendTimer);
        // No frozen cursors: the roster dies with the connection. Clear BEFORE
        // detaching so the caller still hears the final empty roster.
        presence.clearPeers();
        colors.clear();
        presence.onStateChanged.remove(stateChanged);
        presence.onPeersChanged.remove(peersChanged);
        plugin.onRecordAdded.remove(onLocalRecordAdded);
        plugin.onRecordChanged.remove(onLocalRecordChanged);
        opts.onStatus?.("closed");
    };
    ws.addEventListener("close", cleanup);

    return {
        dispose(): void {
            cleanup();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        }
    };
}

/** Room id from the page URL (?room=...); every client redirects to "/" without it. */
export function getRoomIdFromUrl(): string | null {
    return new URLSearchParams(location.search).get("room");
}

/** Local copy of protocol.ts's truncateCodePoints (zero-runtime-imports rule).
 * String#slice counts UTF-16 units and can leave a lone surrogate that makes
 * encodeURIComponent throw on every subsequent connect. */
const truncateName = (s: string): string => [...s].slice(0, 32).join("");

/**
 * Display name for presence: ?name= param (set by the lobby; needed in dev
 * where lobby and clients run on different origins) → localStorage → a
 * generated guest name. Whatever wins is persisted for the next visit.
 */
export function getDisplayName(): string {
    const fromUrl = truncateName((new URLSearchParams(location.search).get("name") ?? "").trim());
    let name = fromUrl;
    try {
        if (!name) name = truncateName((localStorage.getItem("collab.name") ?? "").trim());
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
        localStorage.setItem("collab.name", name);
    } catch {
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    }
    return name;
}
