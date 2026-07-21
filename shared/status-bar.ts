/**
 * Tiny framework-agnostic connection bar shown above the Creator in every
 * client app. Pure DOM, zero imports — same sharing rules as collab-client.ts.
 */
import type { CollabStatus, IPresencePeerLike } from "./collab-client";

export interface IParticipantInfo {
    id: string;
    name: string;
    color: string;
    /** Creator tab the participant is on ("designer", "theme", …). */
    tab: string;
}

/** The connectCollab roster → setParticipants input, shared by every client app. */
export function peersToParticipants(peers: ReadonlyMap<string, IPresencePeerLike>): IParticipantInfo[] {
    return [...peers.values()].map((p) => ({
        id: p.clientId,
        name: p.name,
        color: p.color,
        tab: (p.state as { tab?: string } | undefined)?.tab ?? ""
    }));
}

export interface IStatusBar {
    setStatus(status: CollabStatus): void;
    /** Render remote participants as colored initial chips. */
    setParticipants(users: IParticipantInfo[]): void;
}

/** Chips beyond this count collapse into a "+N" chip. */
const MAX_CHIPS = 8;

const STATUS_COLORS: Record<CollabStatus, string> = {
    connecting: "#b78600",
    connected: "#1e8a4f",
    closed: "#b00020"
};

export function initStatusBar(container: HTMLElement, framework: string, roomId: string): IStatusBar {
    container.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:6px 12px;background:#f5f5f5;" +
        "border-bottom:1px solid #e0e0e0;font:13px system-ui,sans-serif;flex:none;";

    const dot = document.createElement("span");
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;";
    const statusText = document.createElement("strong");

    const room = document.createElement("span");
    room.innerHTML = `Room: <code style="background:#fff;padding:1px 6px;border-radius:3px">${escapeHtml(roomId)}</code>`;

    const fw = document.createElement("span");
    fw.style.color = "#666";
    fw.textContent = framework;

    const participants = document.createElement("span");
    participants.style.cssText = "display:flex;align-items:center;gap:4px;";

    const spacer = document.createElement("span");
    spacer.style.marginLeft = "auto";

    const lobbyBtn = document.createElement("button");
    lobbyBtn.type = "button";
    lobbyBtn.textContent = "Lobby";
    lobbyBtn.addEventListener("click", () => {
        location.href = "/";
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy invite link";
    copyBtn.style.marginLeft = "12px";
    copyBtn.addEventListener("click", () => {
        // The invite leads to the LOBBY with the room prefilled, so the invitee
        // picks their own framework instead of inheriting this tab's one.
        const invite = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
        void navigator.clipboard.writeText(invite);
    });

    spacer.append(lobbyBtn, copyBtn);
    container.append(dot, statusText, room, fw, participants, spacer);

    return {
        setStatus(status: CollabStatus): void {
            dot.style.background = STATUS_COLORS[status];
            statusText.textContent = status;
        },
        setParticipants(users: IParticipantInfo[]): void {
            participants.replaceChildren();
            for (const user of users.slice(0, MAX_CHIPS)) {
                const chip = document.createElement("span");
                chip.className = "collab-participant-chip";
                chip.style.cssText =
                    "width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;" +
                    `justify-content:center;color:#fff;font-size:9px;font-weight:600;background:${user.color};` +
                    "border:1px solid rgba(0,0,0,.15);cursor:default;";
                chip.textContent = presenceInitials(user.name);
                chip.title = `${user.name} — ${user.tab || "?"}`;
                participants.appendChild(chip);
            }
            if (users.length > MAX_CHIPS) {
                const more = document.createElement("span");
                more.style.cssText = "color:#666;font-size:11px;";
                more.textContent = `+${users.length - MAX_CHIPS}`;
                more.title = users.slice(MAX_CHIPS).map((u) => u.name).join(", ");
                participants.appendChild(more);
            }
        }
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Local copy of survey-creator-core's presenceInitials (zero-imports rule). */
function presenceInitials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
