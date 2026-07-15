import { test, expect, type Page } from "@playwright/test";
import WebSocket from "ws";
import { createRoom, questionLocator, uniqueRoomId } from "./utils";

const WS_BASE = "ws://localhost:8080";

/**
 * Minimal protocol-level WS client (runs in Node, not the browser): buffers
 * every server message and lets tests await one matching a predicate.
 */
class ProtoClient {
    private readonly messages: any[] = [];
    private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    private constructor(private readonly ws: WebSocket) {}

    static async connect(roomId: string): Promise<ProtoClient> {
        const ws = new WebSocket(`${WS_BASE}/ws/rooms/${encodeURIComponent(roomId)}`);
        const client = new ProtoClient(ws);
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            const waiter = client.waiters.find((w) => w.pred(msg));
            if (waiter) {
                client.waiters = client.waiters.filter((w) => w !== waiter);
                waiter.resolve(msg);
            } else {
                client.messages.push(msg);
            }
        });
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        return client;
    }

    send(obj: unknown): void {
        this.ws.send(JSON.stringify(obj));
    }

    /** Next (or already buffered) message matching `pred`. */
    next(pred: (m: any) => boolean, timeoutMs = 10_000): Promise<any> {
        const idx = this.messages.findIndex(pred);
        if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { pred, resolve: (m: any) => { clearTimeout(timer); resolve(m); } };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w !== waiter);
                reject(new Error(`timed out waiting for message (${timeoutMs}ms)`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    /** Assert no buffered/arriving message matches `pred` within `windowMs`. */
    async expectNone(pred: (m: any) => boolean, windowMs = 750): Promise<void> {
        await expect(this.next(pred, windowMs)).rejects.toThrow(/timed out/);
    }

    close(): void {
        this.ws.close();
    }
}

test.describe("presence protocol", () => {
    test("init carries a color; roster sync reaches the newcomer; relay has no echo", async () => {
        const roomId = uniqueRoomId("pres-sync");
        const a = await ProtoClient.connect(roomId);
        const initA = await a.next((m) => m.type === "init");
        expect(typeof initA.color).toBe("string");

        a.send({ type: "presence", state: { name: "A", tab: "designer" } });
        // No echo: A never receives its own presence back.
        await a.expectNone((m) => m.type === "presence");

        const b = await ProtoClient.connect(roomId);
        const initB = await b.next((m) => m.type === "init");
        expect(initB.color).not.toBe(initA.color);

        const sync = await b.next((m) => m.type === "presence-sync");
        expect(sync.peers).toHaveLength(1);
        expect(sync.peers[0].clientId).toBe(initA.clientId);
        expect(sync.peers[0].color).toBe(initA.color);
        expect(sync.peers[0].state.name).toBe("A");

        // Live relay: B's update reaches A wrapped in a peer entry.
        b.send({ type: "presence", state: { name: "B", tab: "theme" } });
        const update = await a.next((m) => m.type === "presence");
        expect(update.peer.clientId).toBe(initB.clientId);
        expect(update.peer.state.tab).toBe("theme");

        a.close();
        b.close();
    });

    test("leave broadcast on disconnect; roster forgets the leaver; color slot is reused", async () => {
        const roomId = uniqueRoomId("pres-leave");
        const a = await ProtoClient.connect(roomId);
        const initA = await a.next((m) => m.type === "init");
        a.send({ type: "presence", state: { name: "A" } });

        const b = await ProtoClient.connect(roomId);
        await b.next((m) => m.type === "init");
        await b.next((m) => m.type === "presence-sync");

        a.close();
        const leave = await b.next((m) => m.type === "presence-leave");
        expect(leave.clientId).toBe(initA.clientId);

        // C takes A's freed color slot and gets a roster without A.
        const c = await ProtoClient.connect(roomId);
        const initC = await c.next((m) => m.type === "init");
        expect(initC.color).toBe(initA.color);
        await c.expectNone((m) => m.type === "presence-sync" && m.peers.some((p: any) => p.clientId === initA.clientId));

        b.close();
        c.close();
    });

    test("presence never enters the room log; oversized frames are dropped", async ({ request }) => {
        const roomId = uniqueRoomId("pres-log");
        const a = await ProtoClient.connect(roomId);
        await a.next((m) => m.type === "init");
        const b = await ProtoClient.connect(roomId);
        await b.next((m) => m.type === "init");

        for (let i = 0; i < 20; i++) a.send({ type: "presence", state: { name: "A", i } });
        await b.next((m) => m.type === "presence" && m.peer.state.i === 19);

        const info = await (await request.get(`/api/rooms/${roomId}`)).json();
        expect(info.logLength).toBe(0);

        // A frame over PRESENCE_MAX_BYTES is silently dropped, not relayed.
        a.send({ type: "presence", state: { name: "A", pad: "x".repeat(5000) } });
        await b.expectNone((m) => m.type === "presence" && m.peer.state.pad);

        // The connection survives and ordinary records still relay (old-style
        // append-only clients are unaffected by the presence extension).
        a.send({ type: "append", payload: { hello: 1 } });
        const rec = await b.next((m) => m.type === "record");
        expect(rec.payload.hello).toBe(1);

        a.close();
        b.close();
    });
});

// ---------------------------------------------------------------------------
// Browser-level: two Creator tabs in one room see each other.

async function openRoomAs(page: Page, roomId: string, name: string): Promise<void> {
    // openRoom() waits for the WS init frame; the extra param carries the
    // presence display name (both tabs share the context's localStorage, so
    // each must pin its own name explicitly).
    const initReceived = new Promise<void>((resolve) => {
        page.on("websocket", (ws) => {
            if (!ws.url().includes("/ws/rooms/")) return;
            ws.on("framereceived", (frame) => {
                if (typeof frame.payload === "string" && frame.payload.includes("\"type\":\"init\"")) resolve();
            });
        });
    });
    await page.goto(`/react/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`);
    await initReceived;
    await expect(page.locator(".svc-toolbox__item").first()).toBeVisible();
}

test.describe("presence UI", () => {
    test("participant chips, selection outline, tab badge and remote cursor", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-ui");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
        });

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await openRoomAs(bob, roomId, "Bob");

        // Both see each other in the status bar (peers exclude self).
        await expect(alice.locator(".collab-participant-chip")).toHaveCount(1);
        await expect(alice.locator('.collab-participant-chip[title*="Bob"]')).toBeVisible();
        await expect(bob.locator('.collab-participant-chip[title*="Alice"]')).toBeVisible();

        // Bob selects q1 → Alice sees Bob's colored outline with his name flag.
        await questionLocator(bob, "q1").click();
        await expect(alice.locator(".collab-presence-outline-flag", { hasText: "Bob" })).toBeVisible();
        await expect(alice.locator(".collab-presence-outline")).toBeVisible();

        // Bob moves his mouse over q1 → Alice sees his labeled cursor.
        const box = (await questionLocator(bob, "q1").boundingBox())!;
        await bob.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
        await bob.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        await expect(alice.locator(".collab-presence-cursor-name", { hasText: "Bob" })).toBeVisible();

        // Bob switches to the Preview tab → Alice's badge for Bob reflects it
        // and his designer outline dims (still shown, semi-transparent).
        await bob.locator("#tab-test, #tab-preview").first().click();
        await expect(alice.locator(".collab-presence-badge")).toHaveAttribute("title", /Bob — (test|preview)/);
        await expect(alice.locator(".collab-presence-outline")).toHaveCSS("opacity", "0.5");

        // Bob leaves → all of Bob's artifacts disappear on Alice's side.
        await bob.close();
        await expect(alice.locator(".collab-participant-chip")).toHaveCount(0);
        await expect(alice.locator(".collab-presence-outline")).toBeHidden();
        await expect(alice.locator(".collab-presence-cursor")).toBeHidden();
    });
});
