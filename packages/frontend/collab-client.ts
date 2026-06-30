import type {
    IClientToServer,
    IServerToClient,
    ISyncMessage,
    ISyncStackSnapshot
} from "survey-creator-core";

export interface ICollabClientHandlers {
    onInit(schema: any, clientId: string, stack: ISyncStackSnapshot): void;
    onRemoteSync(message: ISyncMessage, fromClientId: string): void;
    onOpen?(): void;
    onClose?(ev: CloseEvent): void;
    onError?(ev: Event): void;
}

/**
 * Thin WebSocket wrapper for talking to the collaboration server.
 * Stateless beyond the socket and the assigned `clientId`.
 */
export class CollabClient {
    private ws: WebSocket;
    private _clientId: string | null = null;

    constructor(private url: string, private handlers: ICollabClientHandlers) {
        this.ws = new WebSocket(url);
        this.ws.addEventListener("open", () => this.handlers.onOpen?.());
        this.ws.addEventListener("close", (ev) => this.handlers.onClose?.(ev));
        this.ws.addEventListener("error", (ev) => this.handlers.onError?.(ev));
        this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    }

    get clientId(): string | null {
        return this._clientId;
    }

    private onMessage(raw: any): void {
        let parsed: IServerToClient;
        try {
            parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        if (parsed.type === "init") {
            this._clientId = parsed.clientId;
            this.handlers.onInit(parsed.schema, parsed.clientId, parsed.stack);
            return;
        }
        if (parsed.type === "sync") {
            // Defensive: server already excludes the originator.
            if (parsed.from && parsed.from === this._clientId) return;
            this.handlers.onRemoteSync(parsed.message, parsed.from);
        }
    }

    sendSync(message: ISyncMessage): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        const envelope: IClientToServer = { type: "sync", message };
        this.ws.send(JSON.stringify(envelope));
    }

    dispose(): void {
        if (
            this.ws.readyState === WebSocket.OPEN ||
            this.ws.readyState === WebSocket.CONNECTING
        ) {
            this.ws.close();
        }
    }
}
