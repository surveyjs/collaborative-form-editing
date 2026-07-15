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
    const room: Room = { id, seed, log: [], clients: new Map(), colorSlots: new Map(), presence: new Map() };
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

/** Lowest color slot not held by a connected client; a leaver's slot is reusable. */
export function assignColorSlot(room: Room, clientId: string): number {
    const taken = new Set(room.colorSlots.values());
    let slot = 0;
    while (taken.has(slot)) slot++;
    room.colorSlots.set(clientId, slot);
    return slot;
}

export function setPresence(room: Room, clientId: string, state: unknown): void {
    room.presence.set(clientId, state);
}

export function removeClient(room: Room, clientId: string): void {
    room.clients.delete(clientId);
    room.colorSlots.delete(clientId);
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
