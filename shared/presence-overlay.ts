/**
 * Presence OVERLAY: renders remote participants — tab badges, selection
 * outlines, property-grid markers and cursors — into one fixed, pointer-
 * transparent layer above the creator.
 *
 * Geometry is re-derived from DOM anchors on every dirty tick (scroll /
 * resize / DOM mutation / peer update), which makes the layer self-healing:
 * an element that hasn't arrived through the journal yet simply renders
 * nothing until a later tick finds it. No per-artifact error states.
 *
 * Same sharing rules as collab-client.ts: no runtime survey-creator-core
 * imports; the journal locator functions are injected by the client entry.
 */
import { PRESENCE_SELECTORS, presenceInitials, resolveAnchor } from "./presence-types";
import type { IPresenceState } from "./presence-types";
import type { IPresencePeer } from "./collab-client";
import type { IPresenceLocator } from "./presence-capture";

/** Above the creator content; below survey-core popups is acceptable (cosmetic). */
const OVERLAY_Z_INDEX = 1100;
/** A cursor that hasn't moved for this long fades out. */
const CURSOR_IDLE_MS = 30_000;
/** Safety tick for changes no observer catches (animations, scrollIntoView). */
const FALLBACK_TICK_MS = 500;

export interface IPresenceOverlayCreatorLike {
    readonly activeTab: string;
    readonly activeTabId: string;
    readonly selectedElement: unknown;
    readonly survey: unknown;
    readonly rootElement: HTMLElement | undefined;
}

export interface IPresenceOverlayOptions {
    creator: IPresenceOverlayCreatorLike;
    locator: IPresenceLocator;
    getPeers(): ReadonlyMap<string, IPresencePeer>;
}

export interface IPresenceOverlay {
    /** Mark the overlay dirty — call from onPresence. */
    refresh(): void;
    dispose(): void;
}

interface IRect { left: number; top: number; width: number; height: number }

const intersects = (a: IRect, b: IRect): boolean =>
    a.left < b.left + b.width && a.left + a.width > b.left &&
    a.top < b.top + b.height && a.top + a.height > b.top;

/** Per-peer DOM artifacts, created lazily and repositioned every tick. */
interface IPeerArtifacts {
    badge: HTMLElement;
    outline: HTMLElement;
    outlineFlag: HTMLElement;
    pgMarker: HTMLElement;
    cursor: HTMLElement;
    cursorName: HTMLElement;
    /** Receiver-side time of the last observed cursor change (staleness). */
    curChangedAt: number;
    lastCurStamp: number | undefined;
}

export function initPresenceOverlay(opts: IPresenceOverlayOptions): IPresenceOverlay {
    const { creator, locator, getPeers } = opts;
    let disposed = false;

    const layer = document.createElement("div");
    layer.className = "collab-presence-layer";
    layer.style.cssText =
        `position:fixed;inset:0;pointer-events:none;z-index:${OVERLAY_Z_INDEX};` +
        "font:11px system-ui,sans-serif;overflow:hidden;";
    document.body.appendChild(layer);

    const artifacts = new Map<string, IPeerArtifacts>();

    const el = (className: string, css: string): HTMLElement => {
        const node = document.createElement("div");
        node.className = className;
        node.style.cssText = `position:absolute;display:none;${css}`;
        layer.appendChild(node);
        return node;
    };

    const getArtifacts = (peer: IPresencePeer): IPeerArtifacts => {
        let a = artifacts.get(peer.clientId);
        if (a) return a;
        const color = peer.color || "#888";
        a = {
            badge: el("collab-presence-badge", `width:10px;height:10px;border-radius:50%;border:2px solid #fff;box-sizing:border-box;background:${color};`),
            outline: el("collab-presence-outline", `border:2px solid ${color};border-radius:4px;box-sizing:border-box;`),
            outlineFlag: el("collab-presence-outline-flag", `padding:1px 6px;border-radius:3px 3px 3px 0;background:${color};color:#fff;white-space:nowrap;`),
            pgMarker: el("collab-presence-pg-marker", `width:3px;border-radius:2px;background:${color};`),
            cursor: el("collab-presence-cursor", "width:0;height:0;"),
            cursorName: el("collab-presence-cursor-name", `padding:2px 7px;border-radius:10px;background:${color};color:#fff;white-space:nowrap;`),
            curChangedAt: 0,
            lastCurStamp: undefined
        };
        a.cursor.innerHTML =
            `<svg width="16" height="18" viewBox="0 0 16 18" style="display:block">` +
            `<path d="M1 1 L1 14 L4.5 10.8 L7 16.5 L9.3 15.5 L6.8 9.9 L11.5 9.6 Z" ` +
            `fill="${peer.color || "#888"}" stroke="#fff" stroke-width="1"/></svg>`;
        artifacts.set(peer.clientId, a);
        return a;
    };

    const dropArtifacts = (clientId: string): void => {
        const a = artifacts.get(clientId);
        if (!a) return;
        for (const node of [a.badge, a.outline, a.outlineFlag, a.pgMarker, a.cursor, a.cursorName]) node.remove();
        artifacts.delete(clientId);
    };

    const hide = (...nodes: HTMLElement[]): void => nodes.forEach((n) => { n.style.display = "none"; });
    const place = (node: HTMLElement, left: number, top: number, width?: number, height?: number): void => {
        node.style.display = "block";
        node.style.left = `${Math.round(left)}px`;
        node.style.top = `${Math.round(top)}px`;
        if (width !== undefined) node.style.width = `${Math.round(width)}px`;
        if (height !== undefined) node.style.height = `${Math.round(height)}px`;
    };

    // --- anchor resolution helpers ---------------------------------------------

    const designerContainer = (): Element | null =>
        document.querySelector(PRESENCE_SELECTORS.tabContent("designer"));

    /** Selection → the DOM node to outline: direct name anchor, else locator + owner-chain walk. */
    const resolveSelectionNode = (sel: NonNullable<IPresenceState["sel"]>, container: Element): Element | null => {
        const byName = (name: string): Element | null =>
            container.querySelector(PRESENCE_SELECTORS.element(name)) ??
            container.querySelector(PRESENCE_SELECTORS.page(name));
        if (sel.name) {
            const direct = byName(sel.name);
            if (direct) return direct;
        }
        if (!sel.loc) return null; // "" = the survey itself — nothing to outline
        let obj: any;
        try {
            obj = locator.resolve(sel.loc, creator.survey);
        } catch {
            return null;
        }
        // Non-anchorable objects (itemvalue, matrix column, …): climb to the
        // nearest owner that has an adorner in the designer.
        for (let i = 0; obj && i < 20; i++) {
            if (typeof obj.name === "string" && obj.name) {
                const node = byName(obj.name);
                if (node) return node;
            }
            obj = obj.parent ?? obj.parentQuestion ?? obj.colOwner ?? obj.owner ?? null;
        }
        return null;
    };

    /** Locator of the locally selected object — gate for property-grid markers. */
    const localSelectionLoc = (): string | null => {
        if (!creator.selectedElement) return null;
        try {
            return locator.build(creator.selectedElement, creator.survey);
        } catch {
            return null;
        }
    };

    // --- per-tick render ---------------------------------------------------------

    const render = (): void => {
        const peers = getPeers();
        for (const id of [...artifacts.keys()]) {
            if (!peers.has(id)) dropArtifacts(id);
        }
        if (peers.size === 0) return;

        const localTab = creator.activeTab;
        const localTabId = creator.activeTabId;
        const localSelLoc = localSelectionLoc();
        const now = Date.now();
        const sidebar = document.querySelector(PRESENCE_SELECTORS.sidebar);
        const sidebarRect = sidebar?.getBoundingClientRect();
        const designer = designerContainer();
        const designerRect = designer?.getBoundingClientRect();
        const badgeCountPerTab = new Map<string, number>();

        for (const peer of peers.values()) {
            const a = getArtifacts(peer);
            const state = peer.state;

            // 1) tab badge — stacked per tab, right-to-left from the tab's corner
            const tabNode = state.tabId ? document.querySelector(PRESENCE_SELECTORS.tabItem(state.tabId)) : null;
            const badgeAnchor = tabNode ?? document.querySelector(PRESENCE_SELECTORS.tabbedMenu);
            if (badgeAnchor) {
                const idx = badgeCountPerTab.get(state.tabId) ?? 0;
                badgeCountPerTab.set(state.tabId, idx + 1);
                const r = badgeAnchor.getBoundingClientRect();
                place(a.badge, r.right - 12 - idx * 11, r.top + 2);
                a.badge.title = `${state.name} — ${state.tab || "?"}`;
            } else {
                hide(a.badge);
            }

            // 2) selection outline — designer only, dimmed when the peer is elsewhere
            let outlineShown = false;
            if (state.sel && localTab === "designer" && designer && designerRect) {
                const node = resolveSelectionNode(state.sel, designer);
                if (node) {
                    const r = node.getBoundingClientRect();
                    if (intersects(r, designerRect)) {
                        const opacity = state.tab === "designer" ? "1" : "0.5";
                        place(a.outline, r.left - 3, r.top - 3, r.width + 6, r.height + 6);
                        a.outline.style.opacity = opacity;
                        place(a.outlineFlag, r.left - 3, r.top - 21);
                        a.outlineFlag.style.opacity = opacity;
                        a.outlineFlag.textContent = state.name;
                        outlineShown = true;
                    }
                }
            }
            if (!outlineShown) hide(a.outline, a.outlineFlag);

            // 3) property-grid marker — only when the local grid shows the same content
            let markerShown = false;
            if (state.pgFocus && sidebar && sidebarRect) {
                const sameContent = state.pgFocus.grid === "theme"
                    ? localTab === "theme"
                    : state.pgFocus.objLoc !== null && state.pgFocus.objLoc === localSelLoc;
                if (sameContent) {
                    const field = sidebar.querySelector(PRESENCE_SELECTORS.dataName(state.pgFocus.prop));
                    if (field) {
                        const r = field.getBoundingClientRect();
                        if (intersects(r, sidebarRect)) {
                            place(a.pgMarker, r.left - 6, r.top, undefined, r.height);
                            a.pgMarker.title = `${state.name} — ${state.pgFocus.prop}`;
                            markerShown = true;
                        }
                    }
                }
            }
            if (!markerShown) hide(a.pgMarker);

            // 4) cursor — same tab only (tab strip cursors are global), idle fade
            if (state.cur && state.cur.t !== a.lastCurStamp) {
                a.lastCurStamp = state.cur.t;
                a.curChangedAt = now;
            }
            let cursorShown = false;
            const cur = state.cur;
            if (cur && now - a.curChangedAt < CURSOR_IDLE_MS &&
                (cur.a.s === "tabbar" || cur.tab === localTabId)) {
                const node = resolveAnchor(cur.a, cur.tab);
                if (node) {
                    const r = node.getBoundingClientRect();
                    const container = cur.a.s === "pg" ? sidebarRect
                        : cur.a.s === "tabbar" ? undefined
                            : document.querySelector(PRESENCE_SELECTORS.tabContent(cur.tab))?.getBoundingClientRect();
                    if (container === undefined || (container && intersects(r, container))) {
                        const x = r.left + cur.x * r.width;
                        const y = r.top + cur.y * r.height;
                        place(a.cursor, x, y);
                        place(a.cursorName, x + 12, y + 14);
                        a.cursorName.textContent = state.name;
                        cursorShown = true;
                    }
                }
            }
            if (!cursorShown) hide(a.cursor, a.cursorName);
        }
    };

    // --- dirty-flag rAF scheduler ------------------------------------------------

    let rafId = 0;
    let scheduled = false;
    const markDirty = (): void => {
        if (scheduled || disposed) return;
        scheduled = true;
        rafId = requestAnimationFrame(() => {
            scheduled = false;
            if (!disposed) render();
        });
    };

    const onScroll = (): void => markDirty();
    const onResize = (): void => markDirty();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const fallbackTimer = setInterval(markDirty, FALLBACK_TICK_MS);

    // rootElement appears only after the framework renders the creator.
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    let rootPoll = 0;
    const attachObservers = (): void => {
        if (disposed) return;
        const root = creator.rootElement;
        if (!root) {
            rootPoll = requestAnimationFrame(attachObservers);
            return;
        }
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(markDirty);
            resizeObserver.observe(root);
        }
        mutationObserver = new MutationObserver(markDirty);
        mutationObserver.observe(root, { childList: true, subtree: true, attributes: true });
    };
    rootPoll = requestAnimationFrame(attachObservers);

    return {
        refresh: markDirty,
        dispose(): void {
            disposed = true;
            cancelAnimationFrame(rafId);
            cancelAnimationFrame(rootPoll);
            clearInterval(fallbackTimer);
            document.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
            resizeObserver?.disconnect();
            mutationObserver?.disconnect();
            layer.remove();
        }
    };
}
