/**
 * Framework-agnostic collaboration wiring: JournalPlugin ↔ WebSocket.
 *
 * This module has ZERO runtime imports on purpose. It is compiled
 * independently by four differently-built client apps (Vite×3 + Angular CLI);
 * importing "survey-creator-core" from here would resolve to a *second* copy
 * of the library and break survey-core's Serializer singleton. Instead the
 * caller creates the creator and the JournalPlugin from ITS OWN dependency
 * copy and injects them (structural typing below). Type-only imports from
 * sibling shared files are fine — they are erased at compile time.
 *
 * Usage (identical in every client):
 *   const creator = new SurveyCreator(...);            // framework-specific
 *   const plugin = new JournalPlugin(creator);
 *   creator.addPlugin("journal", plugin);
 *   const collab = connectCollab({ creator, plugin, roomId });
 */
import type { IPresenceState } from "./presence-types";

/** Structural mirror of survey-creator-core's EventBase — only what we use. */
export interface IJournalEvent {
    add(handler: (sender: unknown, options: { record: unknown }) => void): void;
}

/** Structural mirror of the JournalPlugin surface we use. */
export interface IJournalPluginLike {
    onRecordAdded: IJournalEvent;
    onRecordChanged: IJournalEvent;
    apply(input: unknown): unknown;
}

/** Structural mirror of the creator — we only set its survey JSON. */
export interface ICreatorLike {
    JSON: unknown;
}

export type CollabStatus = "connecting" | "connected" | "closed";

/** A remote participant as seen through the presence channel. */
export interface IPresencePeer {
    clientId: string;
    /** Server-assigned hex color. */
    color: string;
    state: IPresenceState;
    /** Local receive time (ms) of the last update — used for staleness. */
    lastSeen: number;
}

export interface ICollabOptions {
    creator: ICreatorLike;
    plugin: IJournalPluginLike;
    roomId: string;
    /** Override the WS origin, e.g. "ws://localhost:8080". Default: same origin. */
    wsBase?: string;
    onStatus?: (status: CollabStatus) => void;
    /** Display name announced in presence. Default: getDisplayName(). */
    name?: string;
    /** The peer roster changed (join/update/leave). Excludes self. */
    onPresence?: (peers: ReadonlyMap<string, IPresencePeer>) => void;
}

export interface ICollabConnection {
    dispose(): void;
    /** Server-assigned identity; null until `init` arrives. */
    readonly clientId: string | null;
    /** This client's presence color; null until `init` arrives. */
    readonly color: string | null;
    /** Merge fields into the local presence state and send (throttled). */
    updatePresence(partial: Partial<IPresenceState>): void;
    getPeers(): ReadonlyMap<string, IPresencePeer>;
}

/** Outgoing presence is coalesced to at most one message per this interval. */
const PRESENCE_SEND_MS = 40;
/** Full state re-send interval — the liveness signal for peers' staleness sweeps. */
const PRESENCE_HEARTBEAT_MS = 15_000;
/** Peers silent for longer than this are dropped (3 missed heartbeats). */
const PRESENCE_STALE_MS = 45_000;

export function connectCollab(opts: ICollabOptions): ICollabConnection {
    const { creator, plugin, roomId } = opts;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const base = opts.wsBase ?? `${proto}//${location.host}`;
    const ws = new WebSocket(`${base}/ws/rooms/${encodeURIComponent(roomId)}`);
    opts.onStatus?.("connecting");

    // Gate outgoing records until the init bootstrap has been applied.
    let ready = false;

    // --- presence: own state -------------------------------------------------
    let clientId: string | null = null;
    let color: string | null = null;
    const selfState: IPresenceState = {
        name: opts.name ?? getDisplayName(),
        tab: "", tabId: "", sel: null, pgFocus: null, cur: null
    };

    let lastSentAt = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const sendPresenceNow = (): void => {
        sendTimer = undefined;
        if (!ready || ws.readyState !== WebSocket.OPEN) return;
        lastSentAt = Date.now();
        ws.send(JSON.stringify({ type: "presence", state: selfState }));
    };
    const schedulePresenceSend = (): void => {
        if (sendTimer !== undefined) return;
        const elapsed = Date.now() - lastSentAt;
        if (elapsed >= PRESENCE_SEND_MS) sendPresenceNow();
        else sendTimer = setTimeout(sendPresenceNow, PRESENCE_SEND_MS - elapsed);
    };

    // --- presence: peers ------------------------------------------------------
    const peers = new Map<string, IPresencePeer>();
    const notifyPeers = (): void => opts.onPresence?.(peers);
    const upsertPeer = (entry: { clientId: string; color: string; state: unknown }): void => {
        if (!entry || entry.clientId === clientId || !entry.state) return;
        peers.set(entry.clientId, {
            clientId: entry.clientId,
            color: entry.color,
            state: entry.state as IPresenceState,
            lastSeen: Date.now()
        });
    };

    const heartbeat = setInterval(() => {
        schedulePresenceSend();
        // Staleness backstop for a server that missed a close.
        let dropped = false;
        const cutoff = Date.now() - PRESENCE_STALE_MS;
        for (const [id, peer] of peers) {
            if (peer.lastSeen < cutoff) {
                peers.delete(id);
                dropped = true;
            }
        }
        if (dropped) notifyPeers();
    }, PRESENCE_HEARTBEAT_MS);

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
            color = typeof msg.color === "string" ? msg.color : null;
            // Fresh socket → fresh roster; a presence-sync follows on this socket.
            peers.clear();
            // Bootstrap order matters: seed does NOT produce journal records,
            // then the log replays in server order (apply() suppresses echo).
            creator.JSON = msg.seed ?? {};
            if (Array.isArray(msg.log) && msg.log.length > 0) plugin.apply(msg.log);
            ready = true;
            opts.onStatus?.("connected");
            // Announce ourselves so existing occupants see the newcomer at once.
            schedulePresenceSend();
        } else if (msg.type === "record") {
            plugin.apply(msg.payload);
        } else if (msg.type === "presence-sync") {
            peers.clear();
            if (Array.isArray(msg.peers)) for (const p of msg.peers) upsertPeer(p);
            notifyPeers();
        } else if (msg.type === "presence") {
            upsertPeer(msg.peer);
            notifyPeers();
        } else if (msg.type === "presence-leave") {
            if (peers.delete(msg.clientId)) notifyPeers();
        }
    });

    const sendRecord = (_: unknown, options: { record: unknown }): void => {
        if (ready && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "append", payload: options.record }));
        }
    };
    plugin.onRecordAdded.add(sendRecord);
    // A coalesced record was updated in place — re-send it; the server appends
    // it as a new log entry and replay converges (last write wins).
    plugin.onRecordChanged.add(sendRecord);

    ws.addEventListener("close", () => {
        clearInterval(heartbeat);
        if (sendTimer !== undefined) clearTimeout(sendTimer);
        // No frozen cursors: the roster dies with the connection.
        if (peers.size > 0) {
            peers.clear();
            notifyPeers();
        }
        opts.onStatus?.("closed");
    });

    return {
        get clientId(): string | null { return clientId; },
        get color(): string | null { return color; },
        updatePresence(partial: Partial<IPresenceState>): void {
            // Shallow merge; sub-objects (sel/pgFocus/cur) are replaced wholesale.
            for (const key of Object.keys(partial) as (keyof IPresenceState)[]) {
                if (partial[key] !== undefined) (selfState as any)[key] = partial[key];
            }
            schedulePresenceSend();
        },
        getPeers(): ReadonlyMap<string, IPresencePeer> {
            return peers;
        },
        dispose(): void {
            clearInterval(heartbeat);
            if (sendTimer !== undefined) clearTimeout(sendTimer);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        }
    };
}

/** Room id from the page URL (?room=...); every client redirects to "/" without it. */
export function getRoomIdFromUrl(): string | null {
    return new URLSearchParams(location.search).get("room");
}

/**
 * Display name for presence: ?name= param (set by the lobby; needed in dev
 * where lobby and clients run on different origins) → localStorage → a
 * generated guest name. Whatever wins is persisted for the next visit.
 */
export function getDisplayName(): string {
    const fromUrl = (new URLSearchParams(location.search).get("name") ?? "").trim().slice(0, 32);
    let name = fromUrl;
    try {
        if (!name) name = (localStorage.getItem("collab.name") ?? "").trim().slice(0, 32);
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
        localStorage.setItem("collab.name", name);
    } catch {
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    }
    return name;
}
