import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type {
    ICreateSessionRequest,
    ICreateSessionResponse,
    IClientToServer,
    IServerToClient,
    ISyncMessage
} from "@collab/shared";
import { applyMessage, createSession, deleteSession, getOrCreateSession, getSession, snapshot } from "./session-store.js";

/** Custom (user-chosen) session ids: URL-safe, 1..128 chars. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const PORT = Number(process.env.PORT ?? 8080);
/** How long an empty session lingers before being garbage-collected (ms). */
const EMPTY_SESSION_TTL_MS = Number(process.env.EMPTY_SESSION_TTL_MS ?? 30 * 60 * 1000);
const IS_DEV = (process.env.NODE_ENV ?? "development") !== "production";

// Static client assets (built by `npm -w @collab/client run build`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..", "..", "client");
const CLIENT_DIST = path.resolve(
    process.env.CLIENT_DIST ?? path.join(CLIENT_ROOT, "dist")
);
const CLIENT_DIST_EXISTS = !IS_DEV && fs.existsSync(path.join(CLIENT_DIST, "index.html"));

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8"
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): boolean {
    if (!CLIENT_DIST_EXISTS) return false;
    // Resolve and guard against path traversal.
    const rel = decodeURIComponent(urlPath.replace(/^\/+/, ""));
    const candidate = path.normalize(path.join(CLIENT_DIST, rel || "index.html"));
    if (!candidate.startsWith(CLIENT_DIST)) return false;

    let filePath = candidate;
    let stat: fs.Stats | null = null;
    try {
        stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
            stat = fs.statSync(filePath);
        }
    } catch {
        // SPA fallback for non-asset GETs.
        if (req.method === "GET" && !path.extname(rel)) {
            filePath = path.join(CLIENT_DIST, "index.html");
            try {
                stat = fs.statSync(filePath);
            } catch {
                return false;
            }
        } else {
            return false;
        }
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
}

// ---------------------------------------------------------------------------
// HTTP

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
    if (chunks.length === 0) return {} as T;
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim().length === 0) return {} as T;
    return JSON.parse(text) as T;
}

const ourRequestHandler: http.RequestListener = async (req, res) => {
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

    // POST /api/sessions  { schema? } -> { sessionId }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
        try {
            const body = await readJsonBody<ICreateSessionRequest>(req);
            const session = createSession(body.schema);
            const reply: ICreateSessionResponse = { sessionId: session.id };
            sendJson(res, 201, reply);
        } catch (err) {
            sendJson(res, 400, { error: (err as Error).message });
        }
        return;
    }

    // GET /api/sessions/:id -> { sessionId, schema }
    // If the session does not yet exist, create an empty one on the fly so that
    // any user-chosen URL like /my-super-survey is a valid, joinable link.
    const match = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
        const id = match[1];
        if (!SESSION_ID_RE.test(id)) {
            sendJson(res, 400, { error: "invalid session id" });
            return;
        }
        const session = getOrCreateSession(id);
        sendJson(res, 200, { sessionId: session.id, schema: snapshot(session) });
        return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method === "GET" && serveStatic(req, res, url.pathname)) {
        return;
    }

    sendJson(res, 404, { error: "not found" });
};

const httpServer = http.createServer(ourRequestHandler);

// ---------------------------------------------------------------------------
// WebSocket — /ws/sessions/:id

const wss = new WebSocketServer({ noServer: true });

interface IClientCtx {
    clientId: string;
    sessionId: string;
}

const clientsBySession = new Map<string, Map<string, WebSocket>>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

function addClient(sessionId: string, clientId: string, ws: WebSocket): void {
    let bucket = clientsBySession.get(sessionId);
    if (!bucket) {
        bucket = new Map();
        clientsBySession.set(sessionId, bucket);
    }
    bucket.set(clientId, ws);
    const timer = cleanupTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        cleanupTimers.delete(sessionId);
    }
    const session = getSession(sessionId);
    if (session) session.clientCount = bucket.size;
}

function removeClient(sessionId: string, clientId: string): void {
    const bucket = clientsBySession.get(sessionId);
    if (!bucket) return;
    bucket.delete(clientId);
    const session = getSession(sessionId);
    if (session) session.clientCount = bucket.size;
    if (bucket.size === 0) {
        clientsBySession.delete(sessionId);
        const timer = setTimeout(() => {
            cleanupTimers.delete(sessionId);
            // Only delete if nobody re-joined in the meantime.
            if (!clientsBySession.has(sessionId)) {
                deleteSession(sessionId);
                // eslint-disable-next-line no-console
                console.log(`[session ${sessionId}] garbage-collected after ${EMPTY_SESSION_TTL_MS}ms idle`);
            }
        }, EMPTY_SESSION_TTL_MS);
        cleanupTimers.set(sessionId, timer);
    }
}

function send(ws: WebSocket, msg: IServerToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(sessionId: string, exceptClientId: string, message: ISyncMessage, from: string): void {
    const bucket = clientsBySession.get(sessionId);
    if (!bucket) return;
    for (const [otherId, peer] of bucket) {
        if (otherId === exceptClientId) continue;
        send(peer, { type: "sync", from, message });
    }
}

httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const m = /^\/ws\/sessions\/([^/]+)$/.exec(url.pathname);
    if (!m) {
        // Not ours — leave it for other listeners (e.g. Vite HMR in dev).
        // If nobody handles it the socket will be closed by the runtime.
        return;
    }
    const sessionId = m[1];
    if (!SESSION_ID_RE.test(sessionId)) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
    }
    // Auto-create on first connect so a freshly-typed URL just works.
    getOrCreateSession(sessionId);
    wss.handleUpgrade(req, socket, head, (ws) => {
        const ctx: IClientCtx = { clientId: randomUUID(), sessionId };
        onConnection(ws, ctx);
    });
});

function onConnection(ws: WebSocket, ctx: IClientCtx): void {
    const session = getSession(ctx.sessionId);
    if (!session) {
        ws.close(1011, "session not found");
        return;
    }

    addClient(ctx.sessionId, ctx.clientId, ws);
    // eslint-disable-next-line no-console
    console.log(`[session ${ctx.sessionId}] + client ${ctx.clientId} (now ${session.clientCount})`);

    send(ws, { type: "init", clientId: ctx.clientId, schema: snapshot(session) });

    ws.on("message", (data) => {
        let parsed: IClientToServer;
        try {
            parsed = JSON.parse(data.toString()) as IClientToServer;
        } catch {
            return;
        }
        if (!parsed || parsed.type !== "sync" || !parsed.message) return;
        applyMessage(session, parsed.message);
        broadcast(ctx.sessionId, ctx.clientId, parsed.message, ctx.clientId);
    });

    ws.on("close", () => {
        removeClient(ctx.sessionId, ctx.clientId);
        // eslint-disable-next-line no-console
        console.log(`[session ${ctx.sessionId}] - client ${ctx.clientId}`);
    });

    ws.on("error", () => {
        removeClient(ctx.sessionId, ctx.clientId);
    });
}

const HOST = process.env.HOST ?? "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`collab server listening on http://${HOST}:${PORT}`);
    if (IS_DEV) {
        // eslint-disable-next-line no-console
        console.log(`  serving client via Vite middleware (dev) from ${CLIENT_ROOT}`);
    } else if (CLIENT_DIST_EXISTS) {
        // eslint-disable-next-line no-console
        console.log(`  serving client from ${CLIENT_DIST}`);
    } else {
        // eslint-disable-next-line no-console
        console.log(`  (client dist not found at ${CLIENT_DIST} — API/WS only)`);
    }
});

// ---------------------------------------------------------------------------
// Dev: attach Vite as middleware on the same HTTP server.

async function attachViteMiddleware(): Promise<void> {
    if (!IS_DEV) return;
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
        root: CLIENT_ROOT,
        configFile: path.join(CLIENT_ROOT, "vite.config.ts"),
        appType: "spa",
        server: {
            middlewareMode: true,
            // HMR disabled: avoids extra WebSocket and reload loops in this setup.
            hmr: false
        }
    });

    // Re-route requests: API/WS endpoints go through our handler first;
    // anything else falls through to Vite's middlewares (incl. /@vite/*, modules, index.html).
    httpServer.removeAllListeners("request");
    httpServer.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const isApi =
            url.pathname === "/health" ||
            url.pathname.startsWith("/api/") ||
            url.pathname.startsWith("/ws/");
        if (isApi) {
            ourRequestHandler(req, res);
            return;
        }
        vite.middlewares(req, res);
    });
}

attachViteMiddleware().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start Vite middleware:", err);
    process.exit(1);
});
