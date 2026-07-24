/**
 * Reference implementation of the collaboration protocol (see PROTOCOL.md).
 *
 * Written to read like the specification's pseudocode: plain node:http + ws,
 * no framework, no SurveyJS dependency. Journal records and survey JSON are
 * opaque `unknown` values throughout.
 *
 * Besides the protocol surface (/api/*, /ws/*) it also serves the demo UI:
 * the lobby at "/" and the built clients at /react/, /vue/, /js/, /angular/.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { PRESENCE_MAX_BYTES, PRESENCE_NAME_MAX, PRESENCE_PALETTE, ROOM_ID_RE, truncateCodePoints } from "./protocol.js";
import type { ClientToServer, ICreateRoomRequest, ServerToClient } from "./protocol.js";
import { addClient, appendRecord, assignColorSlot, createRoom, getOrCreateRoom, getRoom, removeClient, setPresence } from "./room-store.js";
import type { Room } from "./room-store.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "localhost";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// HTTP API

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Access-Control-Allow-Origin": "*"
    });
    res.end(payload);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim().length === 0) return {} as T;
    return JSON.parse(text) as T;
}

const requestHandler: http.RequestListener = async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
        return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // POST /api/rooms  { roomId, seed? } → 201 | 409 | 400
    if (req.method === "POST" && url.pathname === "/api/rooms") {
        let body: ICreateRoomRequest;
        try {
            body = await readJsonBody<ICreateRoomRequest>(req);
        } catch {
            sendJson(res, 400, { error: "malformed JSON body" });
            return;
        }
        if (typeof body.roomId !== "string" || !ROOM_ID_RE.test(body.roomId)) {
            sendJson(res, 400, { error: "invalid room id" });
            return;
        }
        if (getRoom(body.roomId)) {
            sendJson(res, 409, { error: "room already exists", roomId: body.roomId });
            return;
        }
        createRoom(body.roomId, body.seed ?? {});
        console.log(`[room ${body.roomId}] created via API`);
        sendJson(res, 201, { roomId: body.roomId });
        return;
    }

    // GET /api/rooms/:id → 200 IRoomInfo | 404 { exists: false } | 400
    const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && roomMatch) {
        const id = decodeURIComponent(roomMatch[1]);
        if (!ROOM_ID_RE.test(id)) {
            sendJson(res, 400, { error: "invalid room id" });
            return;
        }
        const room = getRoom(id);
        if (!room) {
            sendJson(res, 404, { exists: false });
            return;
        }
        sendJson(res, 200, {
            roomId: room.id,
            exists: true,
            clientCount: room.clients.size,
            logLength: room.log.length
        });
        return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method === "GET" && serveStatic(res, url.pathname)) {
        return;
    }

    sendJson(res, 404, { error: "not found" });
};

// ---------------------------------------------------------------------------
// Static serving of the demo UI (not part of the protocol).

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8"
};

/** URL prefix → directory. First existing candidate wins (Angular's builder nests dist). */
function resolveMounts(): Map<string, string> {
    const candidates: Record<string, string[]> = {
        react: ["clients/react/dist"],
        vue: ["clients/vue/dist"],
        js: ["clients/js/dist"],
        angular: ["clients/angular/dist/angular/browser", "clients/angular/dist/browser", "clients/angular/dist"]
    };
    const mounts = new Map<string, string>();
    const lobbyDist = path.join(PROJECT_ROOT, "lobby", "dist");
    if (fs.existsSync(path.join(lobbyDist, "index.html"))) mounts.set("", lobbyDist);
    for (const [prefix, dirs] of Object.entries(candidates)) {
        const found = dirs.map((d) => path.join(PROJECT_ROOT, d)).find((d) => fs.existsSync(path.join(d, "index.html")));
        if (found) mounts.set(prefix, found);
    }
    return mounts;
}

const mounts = resolveMounts();
const CLIENT_PREFIXES = ["react", "vue", "js", "angular"];

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
    const segments = decodeURIComponent(urlPath).replace(/^\/+/, "").split("/");
    // A known client prefix without a built dist is a real 404, not a lobby fallback.
    if (CLIENT_PREFIXES.includes(segments[0]) && !mounts.has(segments[0])) return false;
    const mountDir = mounts.get(mounts.has(segments[0]) ? segments[0] : "");
    if (!mountDir) return false;
    const rel = mounts.has(segments[0]) ? segments.slice(1).join("/") : segments.join("/");

    // Resolve and guard against path traversal.
    let filePath = path.normalize(path.join(mountDir, rel || "index.html"));
    if (!filePath.startsWith(mountDir)) return false;

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
            stat = fs.statSync(filePath);
        }
    } catch {
        // Fallback to the mount's index.html for extensionless paths (deep links).
        if (path.extname(rel)) return false;
        filePath = path.join(mountDir, "index.html");
        try {
            stat = fs.statSync(filePath);
        } catch {
            return false;
        }
    }

    res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": stat.size
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
}

// ---------------------------------------------------------------------------
// WebSocket relay — /ws/rooms/:id

const httpServer = http.createServer(requestHandler);
// Generous maxPayload: `append` carries full survey snapshots. Presence has
// its own much tighter PRESENCE_MAX_BYTES check.
const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });

// WS-level keepalive. A browser answers a protocol ping with a pong at the
// WebSocket layer — no JS involved — so it keeps responding even in a throttled
// or backgrounded tab where app-level (setInterval) heartbeats stall. This is
// the authoritative liveness check: a connection that misses a ping/pong
// round-trip is terminated, firing its close handler and the presence-leave
// broadcast. It also keeps otherwise-idle connections warm through proxies.
const PING_INTERVAL_MS = Number(process.env.PRESENCE_PING_MS ?? 30_000);
type KeepAliveWS = WebSocket & { isAlive?: boolean };
const keepAlive = setInterval(() => {
    for (const client of wss.clients) {
        const ka = client as KeepAliveWS;
        if (ka.isAlive === false) { ka.terminate(); continue; }
        ka.isAlive = false;
        ka.ping();
    }
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(keepAlive));

httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const m = /^\/ws\/rooms\/([^/]+)$/.exec(url.pathname);
    if (!m) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }
    const roomId = decodeURIComponent(m[1]);
    if (!ROOM_ID_RE.test(roomId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
    }
    // Auto-create on first connect (seed {}) so pasted deep links just work.
    const room = getOrCreateRoom(roomId);
    const name = truncateCodePoints((url.searchParams.get("name") ?? "").trim(), PRESENCE_NAME_MAX) || "Guest";
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, room, name));
});

function send(ws: WebSocket, msg: ServerToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const colorOf = (room: Room, id: string): string =>
    PRESENCE_PALETTE[(room.colorSlots.get(id) ?? 0) % PRESENCE_PALETTE.length];

const nameOf = (room: Room, id: string): string => room.names.get(id) ?? "Guest";

// Presence rate limit: token bucket per connection.
const PRESENCE_BUCKET_CAPACITY = 100;
const PRESENCE_TOKENS_PER_SEC = 50;

function onConnection(ws: WebSocket, room: Room, name: string): void {
    const clientId = randomUUID();
    addClient(room, clientId, ws);
    assignColorSlot(room, clientId);
    room.names.set(clientId, name);
    console.log(`[room ${room.id}] + client ${clientId} "${name}" (now ${room.clients.size})`);

    // Keepalive bookkeeping: every pong marks the socket alive; the server-wide
    // interval above pings and terminates any socket that stopped answering.
    const ka = ws as KeepAliveWS;
    ka.isAlive = true;
    ws.on("pong", () => { ka.isAlive = true; });

    // Bootstrap: current seed + full log. Must precede any relayed record.
    send(ws, { type: "init", clientId, color: colorOf(room, clientId), seed: room.seed, log: room.log });
    // Roster of everyone who already announced presence. Same socket right
    // after init, so ordering is guaranteed.
    if (room.presence.size > 0) {
        send(ws, {
            type: "presence-sync",
            peers: [...room.presence].map(([id, state]) => ({ clientId: id, name: nameOf(room, id), color: colorOf(room, id), state }))
        });
    }

    let tokens = PRESENCE_BUCKET_CAPACITY;
    let lastRefill = Date.now();

    ws.on("message", (data) => {
        let msg: ClientToServer;
        try {
            msg = JSON.parse(data.toString()) as ClientToServer;
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "append" && msg.payload != null) {
            appendRecord(room, msg.payload);
            for (const [otherId, peer] of room.clients) {
                if (otherId !== clientId) send(peer, { type: "record", from: clientId, payload: msg.payload });
            }
        } else if (msg.type === "presence" && msg.state != null) {
            // Guards: frame size cap + token bucket; excess is dropped silently.
            // Count raw frame bytes — String#length is UTF-16 units and lets
            // multi-byte frames (e.g. CJK) past the "bytes" cap.
            const frameBytes = Array.isArray(data) ? data.reduce((n, b) => n + b.byteLength, 0) : data.byteLength;
            if (frameBytes > PRESENCE_MAX_BYTES) return;
            const now = Date.now();
            tokens = Math.min(PRESENCE_BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * PRESENCE_TOKENS_PER_SEC);
            lastRefill = now;
            if (tokens < 1) return;
            tokens -= 1;
            // Latest state only, never in the log.
            setPresence(room, clientId, msg.state);
            const peerEntry = { clientId, name: nameOf(room, clientId), color: colorOf(room, clientId), state: msg.state };
            for (const [otherId, peer] of room.clients) {
                if (otherId !== clientId) send(peer, { type: "presence", peer: peerEntry });
            }
        }
    });

    let dropped = false;
    const drop = (): void => {
        if (dropped) return;
        dropped = true;
        removeClient(room, clientId);
        for (const peer of room.clients.values()) {
            send(peer, { type: "presence-leave", clientId });
        }
        console.log(`[room ${room.id}] - client ${clientId} (now ${room.clients.size})`);
    };
    ws.on("close", drop);
    ws.on("error", drop);
}

httpServer.listen(PORT, HOST, () => {
    console.log(`collab server listening on http://${HOST}:${PORT}`);
    for (const [prefix, dir] of mounts) {
        console.log(`  /${prefix}${prefix ? "/" : ""} → ${path.relative(PROJECT_ROOT, dir) || "."}`);
    }
    const missing = ["react", "vue", "js", "angular"].filter((c) => !mounts.has(c));
    if (!mounts.has("")) missing.unshift("lobby");
    if (missing.length) console.log(`  (not built yet: ${missing.join(", ")} — run npm run build:clients)`);
});
