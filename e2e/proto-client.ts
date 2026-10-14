import { expect } from "@playwright/test";
import WebSocket from "ws";

export const WS_BASE = "ws://localhost:8080";

/**
 * Minimal protocol-level WS client (runs in Node, not the browser): buffers
 * every server message and lets tests await one matching a predicate.
 */
export class ProtoClient {
    private readonly messages: any[] = [];
    private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    private constructor(private readonly ws: WebSocket) {}

    static async connect(roomId: string, name?: string): Promise<ProtoClient> {
        const query = name !== undefined ? `?name=${encodeURIComponent(name)}` : "";
        const ws = new WebSocket(`${WS_BASE}/ws/rooms/${encodeURIComponent(roomId)}${query}`);
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
