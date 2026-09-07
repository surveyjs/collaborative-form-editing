/**
 * In-memory room store. Deliberately trivial — this file is the whole "data
 * model" a server port needs to reproduce (see PROTOCOL.md):
 *
 *   room = { id, seed, log[], clients }
 *
 * plus four operations: create, append+broadcast (in index.ts), add/remove
 * client, and TTL garbage-collection of empty rooms.
 */
import type { WebSocket } from "ws";
import { PRESENCE_COLOR_SLOTS } from "./protocol.js";

export interface Room {
    id: string;
    /** Initial survey JSON, opaque to the server. */
    seed: unknown;
    /** Journal records in arrival order, opaque to the server. */
    log: unknown[];
    /** clientId → socket for everyone currently in the room. */
    clients: Map<string, WebSocket>;
    /** clientId → presence color slot, for everyone currently in the room. */
    colorSlots: Map<string, number>;
    /** clientId → display name (from the connection URL), for everyone currently in the room. */
    names: Map<string, string>;
    /** clientId → last presence state (opaque), only for clients that sent one. */
    presence: Map<string, unknown>;
    gcTimer?: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();

/** How long an empty room lingers before being garbage-collected (ms). */
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS ?? 30 * 60 * 1000);

export function getRoom(id: string): Room | undefined {
    return rooms.get(id);
}

export function createRoom(id: string, seed: unknown = {}): Room {
    const room: Room = { id, seed, log: [], clients: new Map(), colorSlots: new Map(), names: new Map(), presence: new Map() };
    rooms.set(id, room);
    return room;
}

export function getOrCreateRoom(id: string): Room {
    return rooms.get(id) ?? createRoom(id);
}

export function appendRecord(room: Room, record: unknown): void {
    // Includes coalesced re-sends of the same logical record; replaying the log
    // in order still converges (the client-side applier is last-write-wins).
    room.log.push(record);
}

export function addClient(room: Room, clientId: string, ws: WebSocket): void {
    room.clients.set(clientId, ws);
    if (room.gcTimer) {
        clearTimeout(room.gcTimer);
        room.gcTimer = undefined;
    }
}

/**
 * First slot in PRESENCE_COLOR_SLOTS not held by a connected client; a leaver's
 * slot is reusable. Past capacity the room repeats a color rather than hand out
 * a slot outside the set, which would render a peer gray or illegible.
 */
export function assignColorSlot(room: Room, clientId: string): number {
    const taken = new Set(room.colorSlots.values());
    const free = PRESENCE_COLOR_SLOTS.find((slot) => !taken.has(slot));
    // colorSlots.size is the count of clients already holding one (addClient
    // does not touch it), so the wrap is deterministic.
    const slot = free ?? PRESENCE_COLOR_SLOTS[room.colorSlots.size % PRESENCE_COLOR_SLOTS.length];
    room.colorSlots.set(clientId, slot);
    return slot;
}

export function setPresence(room: Room, clientId: string, state: unknown): void {
    room.presence.set(clientId, state);
}

export function removeClient(room: Room, clientId: string): void {
    room.clients.delete(clientId);
    room.colorSlots.delete(clientId);
    room.names.delete(clientId);
    room.presence.delete(clientId);
    if (room.clients.size === 0) {
        room.gcTimer = setTimeout(() => {
            if (room.clients.size === 0) {
                rooms.delete(room.id);
                console.log(`[room ${room.id}] garbage-collected after ${EMPTY_ROOM_TTL_MS}ms idle`);
            }
        }, EMPTY_ROOM_TTL_MS);
    }
}
