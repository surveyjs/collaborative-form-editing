/**
 * Tiny framework-agnostic connection bar shown above the Creator in every
 * client app. Pure DOM, zero imports — same sharing rules as collab-client.ts.
 *
 * Styling follows the SurveyJS v2 dark design system (`sjs2/*` tokens). Colors
 * are applied as `var(--sjs2-…, #hex)` so an app-wide dark theme can later drive
 * them, while the hex fallbacks keep the bar correct when the vars are undefined.
 */
import type { CollabStatus, IPresencePeerLike, IRoomChange } from "./collab-client";

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
    /** Render remote participants as colored initial avatars. */
    setParticipants(users: IParticipantInfo[]): void;
    /** Feed the room change log to the "Show Version History" window. */
    setHistory(changes: ReadonlyArray<IRoomChange>): void;
}

export interface IStatusBarOptions {
    /**
     * Invoked by "Save to Version History…" with the name the user typed. The
     * caller creates the labeled snapshot (it owns the JournalPlugin), e.g.
     * `onSaveVersion: (label) => plugin.snapshot(label)`.
     */
    onSaveVersion?: (label: string) => void;
    /**
     * Invoked when a participant chip (or a row in the overflow list) is
     * clicked: jump to the tab that participant is on. The caller owns the
     * creator, e.g. `onGoToParticipant: (u) => { if (u.tab) creator.activeTab = u.tab; }`.
     */
    onGoToParticipant?: (user: IParticipantInfo) => void;
}

/**
 * JournalOp values (see survey-creator-core journal-record.ts). Mirrored as
 * plain numbers per the zero-runtime-imports rule; the wire format is fixed.
 */
enum Op {
    PropertyChanged = 0,
    ArrayChanged = 1,
    ElementRemoved = 2,
    ElementReordered = 3,
    ElementConverted = 4,
    FullSnapshot = 5,
    ElementMoved = 6
}

/** Avatars beyond this count are reachable only through the overflow popover. */
const MAX_AVATARS = 8;

/** SurveyJS v2 design tokens (name → hex fallback), applied as CSS custom props. */
const C = {
    barBg: "var(--sjs2-color-bg-basic-secondary, #222126)",
    border: "var(--sjs2-color-border-basic-secondary, #414045)",
    fg: "var(--sjs2-color-fg-basic-primary, rgba(255,255,255,0.85))",
    surfaceBg: "var(--sjs2-color-component-action-style-tertiary-surface-default-bg, #1c1b20)",
    primaryBg: "var(--sjs2-color-component-action-style-primary-default-bg, #9c40ff)",
    primaryFg: "var(--sjs2-color-component-action-style-primary-default-label, #ffffff)",
    menuBg: "var(--sjs2-color-bg-basic-primary, #2b2a30)",
    // Version-history panel surface + muted (timestamp) foreground.
    sheet: "var(--sjs2-color-utility-sheet, #1c1b20)",
    fgTertiary: "var(--sjs2-color-fg-basic-tertiary, rgba(255,255,255,0.45))"
};

const RADIUS = "var(--sjs2-radius-component-action, 8px)";
const FONT = "600 12px/16px 'Open Sans', system-ui, sans-serif";

const STATUS_COLORS: Record<CollabStatus, string> = {
    connecting: "#b78600",
    connected: "#19b35c",
    closed: "#b00020"
};

const STATUS_LABELS: Record<CollabStatus, string> = {
    connecting: "Connecting…",
    connected: "Connected",
    closed: "Disconnected"
};

const ICON_CHEVRON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
    '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_CLOSE =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round"/></svg>';

const ICON_MINIMIZE =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
    '<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// Horizontal drag handle (two rows of dots), a visual affordance in the header.
const ICON_DRAG =
    '<svg viewBox="0 0 24 16" width="24" height="16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="7" cy="6" r="1.3"/><circle cx="12" cy="6" r="1.3"/><circle cx="17" cy="6" r="1.3"/>' +
    '<circle cx="7" cy="10" r="1.3"/><circle cx="12" cy="10" r="1.3"/><circle cx="17" cy="10" r="1.3"/></svg>';

// Radio-like circle marking a saved version / current version.
const ICON_CHECK_CIRCLE =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>';

const ICON_CHEVRON_DOWN =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">' +
    '<path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_CHEVRON_RIGHT =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">' +
    '<path d="M10 7l5 5-5 5" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_CLOUD_UPLOAD =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">' +
    '<path d="M4.3 13c-1.8 0-3.3-1.5-3.3-3.3 0-1.7 1.3-3.1 3-3.3A4 4 0 0 1 12 6.7' +
    'a3.2 3.2 0 0 1-.5 6.3" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M8 13.5V7m0 0L5.8 9.2M8 7l2.2 2.2" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function initStatusBar(container: HTMLElement, framework: string, roomId: string, options: IStatusBarOptions = {}): IStatusBar {
    // Latest room change log; the history window re-reads it and live-refreshes
    // while open.
    let historyChanges: ReadonlyArray<IRoomChange> = [];
    let refreshHistoryWindow: (() => void) | undefined;
    // Signature of the last rendered participant list, so presence updates that
    // don't change the displayed roster (cursor moves, selection) skip a rebuild.
    let lastParticipantsSig: string | undefined;

    container.style.cssText =
        `display:flex;align-items:center;gap:12px;padding:8px 12px 9px;background:${C.barBg};` +
        `border-bottom:1px solid ${C.border};color:${C.fg};font:${FONT};flex:none;` +
        "box-sizing:border-box;";

    // ── Left block ────────────────────────────────────────────────────────────
    const left = document.createElement("div");
    left.style.cssText = "flex:1 0 0;min-width:0;display:flex;align-items:center;gap:24px;";

    // "Collaboration" dropdown trigger → app menu.
    const menuTrigger = document.createElement("button");
    menuTrigger.type = "button";
    menuTrigger.style.cssText =
        // 32px tall (8px vertical padding) so the trigger fills the bar's content
        // row and top-aligns like the design's `action` component.
        `display:inline-flex;align-items:center;gap:4px;padding:8px 4px 8px 8px;background:${C.surfaceBg};` +
        `color:${C.fg};border:none;border-radius:${RADIUS};box-shadow:inset 0 0 0 1px ${C.border};` +
        `font:${FONT};cursor:pointer;`;
    menuTrigger.innerHTML = `<span>Collaboration</span><span style="display:inline-flex">${ICON_CHEVRON}</span>`;

    const menu = createPopover("left");
    const closeMenu = (): void => { menu.style.display = "none"; };
    menu.append(
        menuButton("Show Version History", () => {
            closeMenu();
            openHistoryWindow();
        }),
        menuButton("Save to Version History…", () => {
            closeMenu();
            openSaveVersionWindow();
        }),
        menuDivider(),
        menuRow("Room", `<code style="background:rgba(255,255,255,.08);padding:1px 6px;border-radius:4px">${escapeHtml(roomId)}</code>`),
        menuRow("Framework", escapeHtml(framework)),
        menuDivider(),
        menuButton("Back to lobby", () => {
            location.href = "/";
        })
    );
    const menuWrap = withPopover(menuTrigger, menu);

    // Status: cloud icon + text. Only shown while the connection has a problem
    // (connecting / closed); hidden once everything is connected.
    const statusEl = document.createElement("div");
    statusEl.style.cssText = "display:none;align-items:center;gap:6px;min-width:0;";
    const statusIcon = document.createElement("span");
    statusIcon.style.cssText = "display:inline-flex;flex:none;";
    statusIcon.innerHTML = ICON_CLOUD_UPLOAD;
    const statusText = document.createElement("span");
    statusText.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    statusEl.append(statusIcon, statusText);

    left.append(menuWrap, statusEl);

    // ── Right block ───────────────────────────────────────────────────────────
    const right = document.createElement("div");
    right.style.cssText = "flex:none;display:flex;align-items:center;justify-content:flex-end;gap:24px;";

    const avatarsGroup = document.createElement("div");
    avatarsGroup.style.cssText = "display:flex;align-items:center;gap:4px;";

    const avatars = document.createElement("div");
    avatars.style.cssText = "display:flex;align-items:center;";

    // Overflow trigger → full participant list.
    const overflowTrigger = document.createElement("button");
    overflowTrigger.type = "button";
    overflowTrigger.setAttribute("aria-label", "Participants");
    overflowTrigger.style.cssText =
        `display:inline-flex;align-items:center;justify-content:center;padding:4px;background:transparent;` +
        `color:${C.fg};border:none;border-radius:${RADIUS};cursor:pointer;`;
    overflowTrigger.innerHTML = ICON_CHEVRON;
    const overflowMenu = createPopover("right");
    const overflowWrap = withPopover(overflowTrigger, overflowMenu);
    // The overflow trigger only makes sense once there are participants to list.
    overflowWrap.style.display = "none";

    avatarsGroup.append(avatars, overflowWrap);

    // "Invite" primary button.
    const inviteBtn = document.createElement("button");
    inviteBtn.type = "button";
    inviteBtn.textContent = "Invite";
    inviteBtn.style.cssText =
        // Match the design's 32px `action` height, aligned with the menu trigger.
        `padding:8px 12px;background:${C.primaryBg};color:${C.primaryFg};border:none;` +
        `border-radius:${RADIUS};font:${FONT};cursor:pointer;`;
    let inviteTimer: ReturnType<typeof setTimeout> | undefined;
    inviteBtn.addEventListener("click", () => {
        // The invite leads to the LOBBY with the room prefilled, so the invitee
        // picks their own framework instead of inheriting this tab's one.
        const invite = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
        void navigator.clipboard.writeText(invite);
        inviteBtn.textContent = "Copied";
        clearTimeout(inviteTimer);
        inviteTimer = setTimeout(() => {
            inviteBtn.textContent = "Invite";
        }, 1500);
    });

    right.append(avatarsGroup, inviteBtn);

    container.append(left, right);

    function renderOverflowMenu(users: IParticipantInfo[]): void {
        overflowMenu.replaceChildren();
        if (users.length === 0) {
            overflowMenu.append(menuRow("Participants", "—"));
            return;
        }
        for (const user of users) {
            const row = document.createElement("div");
            row.className = "collab-participant-row";
            row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;white-space:nowrap;cursor:pointer;";
            row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,.08)"; });
            row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
            const dot = document.createElement("span");
            dot.style.cssText =
                `width:20px;height:20px;border-radius:999px;flex:none;display:inline-flex;align-items:center;` +
                `justify-content:center;color:#fff;font-size:9px;font-weight:600;background:${user.color};`;
            dot.textContent = presenceInitials(user.name);
            const label = document.createElement("span");
            label.textContent = user.name;
            row.append(dot, label);
            // Click a participant → close the list and follow them to their tab.
            row.addEventListener("click", () => {
                overflowMenu.style.display = "none";
                options.onGoToParticipant?.(user);
            });
            overflowMenu.appendChild(row);
        }
    }

    // ── Version History panel (right-docked) ───────────────────────────────────
    function openHistoryWindow(): void {
        // Single instance: re-selecting the menu item while open is a no-op.
        if (refreshHistoryWindow) return;
        const panel = createPanel("Version History");
        // Per-group expand/collapse, keyed by the group's first change; survives
        // live re-renders. Absent key → default (newest group open, rest closed).
        const groupState = new Map<string, boolean>();

        const render = (): void => {
            panel.body.replaceChildren();
            const timeline = buildTimeline(historyChanges); // oldest → newest
            let newestGroupKey: string | null = null;
            for (let i = timeline.length - 1; i >= 0; i--) {
                if (timeline[i].type === "group") { newestGroupKey = groupKey(timeline[i]); break; }
            }

            panel.body.appendChild(currentVersionRow());

            // Newest at the top.
            for (let i = timeline.length - 1; i >= 0; i--) {
                const node = timeline[i];
                if (node.type === "named") {
                    panel.body.appendChild(namedVersionRow(node.change));
                } else {
                    const key = groupKey(node);
                    const expanded = groupState.has(key) ? !!groupState.get(key) : key === newestGroupKey;
                    panel.body.appendChild(groupHeaderRow(node.changes.length, expanded, () => {
                        groupState.set(key, !expanded);
                        render();
                    }));
                    if (expanded) panel.body.appendChild(autosavedGroupBody(node.changes));
                }
            }

            panel.body.appendChild(documentCreatedRow());
        };
        render();
        // Live-refresh while open; detach on close.
        refreshHistoryWindow = render;
        panel.onClose(() => { refreshHistoryWindow = undefined; });
    }

    // ── Save to Version History window ─────────────────────────────────────────
    function openSaveVersionWindow(): void {
        const modal = createModal("Save to Version History");
        const label = document.createElement("label");
        label.textContent = "Version name";
        label.style.cssText = "display:block;margin-bottom:6px;opacity:.7;";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "collab-version-name";
        input.placeholder = "e.g. Before rewording section 2";
        input.style.cssText =
            `width:100%;box-sizing:border-box;padding:8px 10px;background:${C.barBg};color:${C.fg};` +
            `border:1px solid ${C.border};border-radius:${RADIUS};font:${FONT};margin-bottom:12px;`;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText =
            `padding:8px 12px;background:${C.surfaceBg};color:${C.fg};border:none;box-shadow:inset 0 0 0 1px ${C.border};` +
            `border-radius:${RADIUS};font:${FONT};cursor:pointer;`;
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "Save";
        saveBtn.style.cssText =
            `padding:8px 12px;background:${C.primaryBg};color:${C.primaryFg};border:none;` +
            `border-radius:${RADIUS};font:${FONT};cursor:pointer;`;
        const submit = (): void => {
            options.onSaveVersion?.(input.value.trim());
            modal.close();
        };
        cancelBtn.addEventListener("click", () => modal.close());
        saveBtn.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        actions.append(cancelBtn, saveBtn);
        modal.body.append(label, input, actions);
        input.focus();
    }

    return {
        setStatus(status: CollabStatus): void {
            // Surface the status plate only when there's a problem to report.
            statusEl.style.display = status === "connected" ? "none" : "flex";
            statusIcon.style.color = STATUS_COLORS[status];
            statusText.textContent = STATUS_LABELS[status];
        },
        setHistory(changes: ReadonlyArray<IRoomChange>): void {
            historyChanges = changes;
            refreshHistoryWindow?.();
        },
        setParticipants(users: IParticipantInfo[]): void {
            // Presence updates fire on every remote cursor move / selection, but
            // the bar only shows id/name/color/tab. Skip the rebuild when none of
            // those changed (order included: avatars stack by position).
            const sig = users.map((u) => `${u.id}${u.name}${u.color}${u.tab}`).join("");
            if (sig === lastParticipantsSig) return;
            lastParticipantsSig = sig;

            overflowWrap.style.display = users.length > 0 ? "inline-flex" : "none";
            avatars.replaceChildren();
            const shown = users.slice(0, MAX_AVATARS);
            shown.forEach((user, i) => {
                const avatar = document.createElement("span");
                avatar.className = "collab-participant-chip";
                avatar.style.cssText =
                    // 28px colored circle (per Figma). The 2px separator ring is an
                    // OUTSET box-shadow, not a border, so it doesn't shrink the fill
                    // to 24px or grow the layout box.
                    `width:28px;height:28px;border-radius:999px;box-sizing:border-box;display:inline-flex;` +
                    `align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600;` +
                    `background:${user.color};box-shadow:0 0 0 2px ${C.barBg};margin-right:-3px;` +
                    // Later avatars sit on top of earlier ones, matching the design.
                    `position:relative;z-index:${i + 1};cursor:pointer;`;
                avatar.textContent = presenceInitials(user.name);
                avatar.title = `${user.name} — ${user.tab || "?"}`;
                // Click a chip → follow that participant to their tab.
                avatar.addEventListener("click", () => options.onGoToParticipant?.(user));
                avatars.appendChild(avatar);
            });
            renderOverflowMenu(users);
        }
    };
}

/** Absolute popover panel used by the app menu and the participants list. */
function createPopover(align: "left" | "right"): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText =
        `position:absolute;top:calc(100% + 6px);${align}:0;min-width:180px;background:${C.menuBg};` +
        `color:${C.fg};border:1px solid ${C.border};border-radius:${RADIUS};` +
        "box-shadow:0 8px 24px rgba(0,0,0,.4);padding:4px 0;z-index:1000;display:none;font:" + FONT + ";";
    return el;
}

/** Wraps a trigger + popover in a relative container and wires open/close. */
function withPopover(trigger: HTMLElement, popover: HTMLDivElement): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:inline-flex;";
    wrap.append(trigger, popover);

    const close = (): void => {
        popover.style.display = "none";
    };
    const onDocMouseDown = (e: MouseEvent): void => {
        if (!wrap.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") close();
    };

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = popover.style.display === "none";
        popover.style.display = open ? "block" : "none";
        if (open) {
            document.addEventListener("mousedown", onDocMouseDown);
            document.addEventListener("keydown", onKeyDown);
        } else {
            document.removeEventListener("mousedown", onDocMouseDown);
            document.removeEventListener("keydown", onKeyDown);
        }
    });
    return wrap;
}

function menuRow(label: string, valueHtml: string): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 12px;white-space:nowrap;";
    row.innerHTML = `<span style="opacity:.7">${escapeHtml(label)}</span><span>${valueHtml}</span>`;
    return row;
}

function menuButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText =
        `display:block;width:100%;text-align:left;padding:6px 12px;background:transparent;` +
        `color:${C.fg};border:none;font:${FONT};cursor:pointer;`;
    btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255,255,255,.08)";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
    });
    btn.addEventListener("click", onClick);
    return btn;
}

function menuDivider(): HTMLDivElement {
    const hr = document.createElement("div");
    hr.style.cssText = `height:1px;margin:4px 0;background:${C.border};`;
    return hr;
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

interface IModal {
    /** Content container to append the window body into. */
    body: HTMLDivElement;
    close(): void;
    /** Register a callback fired once when the window closes (any route). */
    onClose(handler: () => void): void;
}

/** Centered modal window over a dimmed backdrop. Closes on ✕, backdrop, Escape. */
function createModal(title: string): IModal {
    const overlay = document.createElement("div");
    overlay.className = "collab-modal";
    overlay.style.cssText =
        // Above the bar's popovers (z-index:1000).
        "position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,.5);";
    const card = document.createElement("div");
    card.style.cssText =
        `background:${C.menuBg};color:${C.fg};border:1px solid ${C.border};border-radius:${RADIUS};` +
        `box-shadow:0 8px 24px rgba(0,0,0,.4);width:min(520px,92vw);max-height:80vh;` +
        `display:flex;flex-direction:column;box-sizing:border-box;font:${FONT};`;
    const header = document.createElement("div");
    header.style.cssText =
        `display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;` +
        `border-bottom:1px solid ${C.border};flex:none;`;
    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.cssText = "font-size:14px;font-weight:600;";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.style.cssText =
        `display:inline-flex;align-items:center;justify-content:center;padding:4px;background:transparent;` +
        `color:${C.fg};border:none;border-radius:${RADIUS};cursor:pointer;flex:none;`;
    header.append(titleEl, closeBtn);
    const body = document.createElement("div");
    body.style.cssText = "padding:12px 16px;overflow:auto;";
    card.append(header, body);
    overlay.appendChild(card);

    const closeHandlers: Array<() => void> = [];
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        for (const h of closeHandlers) h();
    };
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    // Backdrop click (but not clicks bubbling up from the card).
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);

    return { body, close, onClose: (h) => closeHandlers.push(h) };
}

const FONT_TEXT = "400 16px/24px 'Open Sans', system-ui, sans-serif";
const FONT_TEXT_STRONG = "600 16px/24px 'Open Sans', system-ui, sans-serif";

/**
 * Right-docked floating panel for Version History. Closes on ✕ or Escape; the
 * ─ button minimizes it to just the header. No backdrop — the Creator stays
 * usable alongside it.
 */
function createPanel(title: string): IModal {
    const panel = document.createElement("div");
    panel.className = "collab-version-panel";
    panel.style.cssText =
        `position:fixed;top:12px;right:12px;bottom:12px;width:360px;max-width:calc(100vw - 24px);z-index:2000;` +
        `background:${C.sheet};color:${C.fg};border:1px solid ${C.border};border-radius:12px;` +
        `box-shadow:0 6px 20px rgba(17,16,20,0.6);display:flex;flex-direction:column;` +
        `box-sizing:border-box;overflow:hidden;font:${FONT_TEXT};`;

    // Header: title + centered drag affordance + minimize + close.
    const header = document.createElement("div");
    header.style.cssText =
        `position:relative;display:flex;align-items:center;gap:4px;padding:12px;` +
        `border-bottom:1px solid ${C.border};flex:none;`;
    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.cssText = `flex:1 0 0;min-width:0;font:${FONT_TEXT_STRONG};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    const drag = document.createElement("span");
    drag.setAttribute("aria-hidden", "true");
    drag.style.cssText = `position:absolute;left:50%;top:4px;transform:translateX(-50%);color:${C.fgTertiary};display:inline-flex;`;
    drag.innerHTML = ICON_DRAG;
    const minimizeBtn = ghostIconButton(ICON_MINIMIZE, "Minimize");
    const closeBtn = ghostIconButton(ICON_CLOSE, "Close");
    header.append(titleEl, minimizeBtn, closeBtn, drag);

    const body = document.createElement("div");
    body.className = "collab-version-body";
    body.style.cssText = "padding:12px;overflow:auto;flex:1 0 0;";

    panel.append(header, body);

    const closeHandlers: Array<() => void> = [];
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKeyDown);
        panel.remove();
        for (const h of closeHandlers) h();
    };
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    let minimized = false;
    minimizeBtn.addEventListener("click", () => {
        minimized = !minimized;
        body.style.display = minimized ? "none" : "block";
        // Collapse the panel to its header when minimized.
        panel.style.bottom = minimized ? "auto" : "12px";
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(panel);

    return { body, close, onClose: (h) => closeHandlers.push(h) };
}

function ghostIconButton(svg: string, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.style.cssText =
        `display:inline-flex;align-items:center;justify-content:center;padding:6px;background:transparent;` +
        `color:${C.fgTertiary};border:none;border-radius:${RADIUS};cursor:pointer;flex:none;`;
    btn.addEventListener("mouseenter", () => { btn.style.background = "rgba(255,255,255,.08)"; btn.style.color = C.fg; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; btn.style.color = C.fgTertiary; });
    return btn;
}

type TimelineNode =
    | { type: "named"; change: IRoomChange }
    | { type: "group"; changes: IRoomChange[] };

/** A saved (named) version = a FullSnapshot carrying a non-empty label. */
function isNamedVersion(c: IRoomChange): boolean {
    return c.op === Op.FullSnapshot && !!c.payload && typeof c.payload.label === "string" && c.payload.label !== "";
}

/**
 * Partition the room change log (oldest→newest) into named versions and runs
 * of "autosaved" edits (everything else) between them.
 */
function buildTimeline(changes: ReadonlyArray<IRoomChange>): TimelineNode[] {
    const nodes: TimelineNode[] = [];
    let group: { type: "group"; changes: IRoomChange[] } | null = null;
    for (const c of changes) {
        if (isNamedVersion(c)) {
            group = null;
            nodes.push({ type: "named", change: c });
        } else {
            if (!group) { group = { type: "group", changes: [] }; nodes.push(group); }
            group.changes.push(c);
        }
    }
    return nodes;
}

/** Stable per-render key for a group (its first change), to preserve expansion. */
function groupKey(node: TimelineNode): string {
    if (node.type !== "group" || node.changes.length === 0) return "";
    const f = node.changes[0];
    return `${f.timestamp}:${f.seq}`;
}

function circleIcon(): HTMLElement {
    const span = document.createElement("span");
    span.style.cssText = "flex:none;display:inline-flex;width:24px;height:24px;";
    span.innerHTML = ICON_CHECK_CIRCLE;
    return span;
}

/** The highlighted top row representing the live current state. */
function currentVersionRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "collab-version-current";
    row.style.cssText =
        `display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;margin-bottom:2px;` +
        `background:${C.primaryBg};color:${C.primaryFg};border-radius:${RADIUS};`;
    const title = document.createElement("div");
    title.textContent = "Current Version";
    title.style.cssText = `flex:1 0 0;min-width:0;font:${FONT_TEXT_STRONG};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    row.append(circleIcon(), title);
    return row;
}

/** A named version or the base "Document created" row (icon + title + time). */
function versionItem(className: string, title: string, time: string): HTMLElement {
    const row = document.createElement("div");
    row.className = className;
    row.style.cssText = `display:flex;flex-direction:column;gap:6px;padding:8px 8px 8px 12px;border-radius:${RADIUS};cursor:default;`;
    row.addEventListener("mouseenter", () => { row.style.background = C.barBg; });
    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

    const line1 = document.createElement("div");
    line1.style.cssText = "display:flex;align-items:center;gap:12px;";
    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.cssText = `flex:1 0 0;min-width:0;font:${FONT_TEXT};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    line1.append(circleIcon(), titleEl);
    row.append(line1);

    if (time) {
        const line2 = document.createElement("div");
        line2.style.cssText = "display:flex;align-items:center;gap:12px;";
        const spacer = document.createElement("span");
        spacer.style.cssText = "flex:none;width:24px;";
        const timeEl = document.createElement("div");
        timeEl.textContent = time;
        timeEl.style.cssText = `flex:1 0 0;min-width:0;font:${FONT_TEXT};color:${C.fgTertiary};`;
        line2.append(spacer, timeEl);
        row.append(line2);
    }
    return row;
}

function namedVersionRow(change: IRoomChange): HTMLElement {
    const label = change.payload && change.payload.label;
    return versionItem("collab-version-named", label ? String(label) : "Saved version", formatVersionTime(change.timestamp));
}

function documentCreatedRow(): HTMLElement {
    // The seed state; the server sends no creation time, so no timestamp here.
    return versionItem("collab-version-base", "Document created", "");
}

/** Collapsible "N autosaved versions" header. */
function groupHeaderRow(count: number, expanded: boolean, onToggle: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collab-version-group";
    btn.style.cssText =
        `display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 8px 8px 12px;` +
        `background:transparent;color:${C.fg};border:none;border-radius:${RADIUS};cursor:pointer;font:${FONT};`;
    const chev = document.createElement("span");
    chev.style.cssText = "flex:none;display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;";
    chev.innerHTML = expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT;
    const label = document.createElement("span");
    label.textContent = `${count} autosaved version${count === 1 ? "" : "s"}`;
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    btn.append(chev, label);
    btn.addEventListener("mouseenter", () => { btn.style.background = C.barBg; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
    btn.addEventListener("click", onToggle);
    return btn;
}

/** Expanded body of an autosaved group: timestamps with a left connector line. */
function autosavedGroupBody(changes: IRoomChange[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;";
    const line = document.createElement("div");
    line.style.cssText = "position:absolute;left:23px;top:0;bottom:0;width:1px;background:rgba(255,255,255,.25);";
    wrap.appendChild(line);
    for (let i = changes.length - 1; i >= 0; i--) { // newest first
        const row = document.createElement("div");
        row.className = "collab-version-autosaved";
        row.style.cssText = `padding:8px 8px 8px 48px;border-radius:${RADIUS};cursor:default;position:relative;`;
        row.addEventListener("mouseenter", () => { row.style.background = C.barBg; });
        row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
        const time = document.createElement("div");
        time.textContent = formatVersionTime(changes[i].timestamp);
        time.style.cssText = `font:${FONT_TEXT};color:${C.fgTertiary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
        row.appendChild(time);
        wrap.appendChild(row);
    }
    return wrap;
}

/** Absolute date + 24h time, e.g. "Jul 10, 19:30". */
function formatVersionTime(ts: number): string {
    if (typeof ts !== "number" || !isFinite(ts)) return "";
    const d = new Date(ts);
    const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date}, ${time}`;
}
