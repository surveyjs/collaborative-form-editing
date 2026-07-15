/**
 * Presence state shape + the DOM anchor codec shared by the capture and
 * overlay modules. Zero runtime imports — same sharing rules as
 * collab-client.ts. The wire envelope is defined in server/protocol.ts; the
 * server treats the state as opaque, so THIS file is the source of truth for
 * what's inside.
 *
 * Every DOM selector presence relies on is centralized here: if the Creator
 * ever renames an attribute, this is the only file to fix.
 */

/**
 * What kind of DOM node a cursor anchor points at:
 *  - "el"     designer question/panel adorner  [data-sv-drop-target-survey-element=n]
 *  - "page"   designer page adorner            [data-sv-drop-target-survey-page=n]
 *  - "pg"     property-grid field              .svc-side-bar [data-name=n]
 *  - "q"      inner-survey question of a tab   #scrollableDiv-{tab} [data-name=n]
 *  - "tabbar" a tab strip item                 #tab-{n}
 *  - "root"   the tab's scroll container       #scrollableDiv-{tab}
 */
export type AnchorScope = "el" | "page" | "pg" | "q" | "tabbar" | "root";

export interface IAnchorRef {
    s: AnchorScope;
    n?: string;
}

export interface IPresenceState {
    /** Display name, chosen in the lobby. */
    name: string;
    /** creator.activeTab (viewType): designer|test|theme|logic|translation|editor. */
    tab: string;
    /** creator.activeTabId — the key of the #tab-{id} / #scrollableDiv-{id} anchors. */
    tabId: string;
    /** Selected element, or null when nothing is selected. */
    sel: null | {
        /** JournalLocator JSON pointer; "" = the survey itself. */
        loc: string;
        /** element.name — direct DOM anchor; null for non-anchorable objects. */
        name: string | null;
        /** element.getType(). */
        kind: string;
        /** Human-readable label for badges/tooltips. */
        title: string;
    };
    /** Focused property-grid field, or null. */
    pgFocus: null | {
        grid: "main" | "theme";
        /** Question name in the grid survey == property name. */
        prop: string;
        /** Locator of the object the grid shows (null for the theme grid). */
        objLoc: string | null;
    };
    /** Mouse cursor, or null when the mouse left the creator. */
    cur: null | {
        /** tabId the cursor was captured on. */
        tab: string;
        a: IAnchorRef;
        /** Position inside the anchor's border box, fractions 0..1. */
        x: number;
        y: number;
        /** Sender epoch ms of the last move. Dedupe only — never compare to local clocks. */
        t: number;
    };
    /** Reserved for tab-specific extras. Mind PRESENCE_MAX_BYTES (4 KB). */
    detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Centralized selectors

/** data-sv-drop-target-survey-element values that are drag&drop ghosts, not elements. */
const GHOST_ELEMENT_NAMES = new Set(["sv-drag-drop-ghost-survey-element-name", "newGhostPage"]);

const cssEsc = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");

export const PRESENCE_SELECTORS = {
    element: (name: string): string => `[data-sv-drop-target-survey-element="${cssEsc(name)}"]`,
    page: (name: string): string => `[data-sv-drop-target-survey-page="${cssEsc(name)}"]`,
    sidebar: ".svc-side-bar",
    dataName: (name: string): string => `[data-name="${cssEsc(name)}"]`,
    tabItem: (tabId: string): string => `#${cssEsc(`tab-${tabId}`)}`,
    tabContent: (tabId: string): string => `#${cssEsc(`scrollableDiv-${tabId}`)}`,
    tabbedMenu: ".svc-tabbed-menu"
};

// ---------------------------------------------------------------------------
// Anchor codec — encode on the capturing side, resolve on the rendering side.
// Both sides must agree, which is why they live in one file.

/**
 * Encode the most specific stable anchor for a point over `target`.
 * `activeTabId` scopes the "q"/"root" fallbacks to the current tab.
 */
export function encodeAnchor(target: Element, activeTabId: string): { a: IAnchorRef; el: Element } | null {
    const el = target.closest("[data-sv-drop-target-survey-element]");
    if (el) {
        const n = el.getAttribute("data-sv-drop-target-survey-element") ?? "";
        if (n && !GHOST_ELEMENT_NAMES.has(n)) return { a: { s: "el", n }, el };
    }
    const page = target.closest("[data-sv-drop-target-survey-page]");
    if (page) {
        const n = page.getAttribute("data-sv-drop-target-survey-page") ?? "";
        if (n && !GHOST_ELEMENT_NAMES.has(n)) return { a: { s: "page", n }, el: page };
    }
    const named = target.closest("[data-name]");
    if (named) {
        const n = named.getAttribute("data-name") ?? "";
        if (n) {
            if (named.closest(PRESENCE_SELECTORS.sidebar)) return { a: { s: "pg", n }, el: named };
            if (named.closest(PRESENCE_SELECTORS.tabContent(activeTabId))) return { a: { s: "q", n }, el: named };
        }
    }
    const tabItem = target.closest('[id^="tab-"]');
    if (tabItem && (tabItem.getAttribute("role") === "tab" || tabItem.classList.contains("svc-tabbed-menu-item"))) {
        return { a: { s: "tabbar", n: tabItem.id.slice("tab-".length) }, el: tabItem };
    }
    const container = target.closest(PRESENCE_SELECTORS.tabContent(activeTabId));
    if (container) return { a: { s: "root" }, el: container };
    return null;
}

/** Resolve an anchor back to a DOM node; null when it doesn't exist (yet). */
export function resolveAnchor(a: IAnchorRef, tabId: string): Element | null {
    const scoped = (sel: string): Element | null => {
        const container = document.querySelector(PRESENCE_SELECTORS.tabContent(tabId));
        return container ? container.querySelector(sel) : null;
    };
    switch (a.s) {
        case "el": return a.n ? scoped(PRESENCE_SELECTORS.element(a.n)) : null;
        case "page": return a.n ? scoped(PRESENCE_SELECTORS.page(a.n)) : null;
        case "pg": return a.n
            ? document.querySelector(`${PRESENCE_SELECTORS.sidebar} ${PRESENCE_SELECTORS.dataName(a.n)}`)
            : null;
        case "q": return a.n ? scoped(PRESENCE_SELECTORS.dataName(a.n)) : null;
        case "tabbar": return a.n ? document.querySelector(PRESENCE_SELECTORS.tabItem(a.n)) : null;
        case "root": return document.querySelector(PRESENCE_SELECTORS.tabContent(tabId));
        default: return null;
    }
}

// ---------------------------------------------------------------------------
// Small display helpers

export function presenceInitials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
