/**
 * Presence CAPTURE: watches the local creator (active tab, selected element,
 * property-grid focus, mouse) and pushes partial presence updates into the
 * transport (`collab.updatePresence`).
 *
 * Framework-agnostic and creator-agnostic by structural typing, like
 * collab-client.ts: no runtime imports from survey-creator-core. The journal
 * locator functions are INJECTED by the client entry from its own
 * survey-creator-core copy (see the dual-Serializer note in collab-client.ts).
 */
import { encodeAnchor } from "./presence-types";
import type { IPresenceState } from "./presence-types";

/** Mouse updates are throttled to this interval (trailing edge). */
const MOUSE_THROTTLE_MS = 50;
/** How long after focus leaves the sidebar before pgFocus is cleared. */
const PG_BLUR_DEBOUNCE_MS = 300;

export interface IPresenceLocator {
    /** journal-locator buildLocator: object → JSON pointer ("" = survey). */
    build(obj: unknown, survey: unknown): string;
    /** journal-locator resolveLocator: JSON pointer → object | undefined. */
    resolve(loc: string, survey: unknown): unknown;
}

interface ICreatorEventLike {
    add(handler: (sender: unknown, options: any) => void): void;
    remove(handler: (sender: unknown, options: any) => void): void;
}

/** Structural mirror of SurveyCreatorModel — only what capture uses. */
export interface IPresenceCreatorLike {
    activeTab: string;
    readonly activeTabId: string;
    selectedElement: any;
    survey: unknown;
    readonly rootElement: HTMLElement | undefined;
    onActiveTabChanged: ICreatorEventLike;
    onElementSelected: ICreatorEventLike;
    onSurveyInstanceCreated: ICreatorEventLike;
}

export interface IPresenceCaptureOptions {
    creator: IPresenceCreatorLike;
    locator: IPresenceLocator;
    send(partial: Partial<IPresenceState>): void;
}

export function initPresenceCapture(opts: IPresenceCaptureOptions): { dispose(): void } {
    const { creator, locator, send } = opts;
    let disposed = false;

    // --- tab ------------------------------------------------------------------
    const sendTab = (): void => {
        // Cursor coordinates are meaningless on the new tab until the next move.
        send({ tab: creator.activeTab ?? "", tabId: creator.activeTabId ?? "", cur: null });
    };
    const onTabChanged = (): void => sendTab();
    creator.onActiveTabChanged.add(onTabChanged);

    // --- selection --------------------------------------------------------------
    const sendSelection = (element: any): void => {
        if (!element) {
            send({ sel: null });
            return;
        }
        let loc = "";
        try {
            loc = locator.build(element, creator.survey);
        } catch {
            // Objects outside the survey tree (e.g. creator settings) aren't shareable.
            send({ sel: null });
            return;
        }
        const name = typeof element.name === "string" && element.name ? element.name : null;
        const kind = typeof element.getType === "function" ? element.getType() : "";
        const title = String(element.title || element.name || kind || "survey");
        send({ sel: { loc, name, kind, title } });
    };
    const onElementSelected = (_: unknown, options: any): void => sendSelection(options?.element);
    creator.onElementSelected.add(onElementSelected);

    // --- property-grid focus ------------------------------------------------------
    // The grid is a generated survey; question name == property name. Hooking
    // at instance creation survives the grid being rebuilt on every selection
    // change — the exact mechanism PropertyGridModel uses internally.
    const onSurveyInstanceCreated = (_: unknown, options: any): void => {
        const grid = options?.area === "property-grid" ? "main"
            : options?.area === "theme-tab:property-grid" ? "theme"
                : null;
        if (!grid || !options.survey?.onFocusInQuestion) return;
        const gridObj = options.obj;
        options.survey.onFocusInQuestion.add((_s: unknown, o: any) => {
            if (disposed || !o?.question?.name) return;
            let objLoc: string | null = null;
            if (grid === "main" && gridObj) {
                try {
                    objLoc = locator.build(gridObj, creator.survey);
                } catch { /* non-survey object — marker still useful without objLoc */ }
            }
            send({ pgFocus: { grid, prop: o.question.name, objLoc } });
        });
    };
    creator.onSurveyInstanceCreated.add(onSurveyInstanceCreated);

    // Clear pgFocus when keyboard focus leaves the sidebar (survey-core has no
    // focus-out event, so this is DOM-level). Debounced: re-focusing another
    // grid field within the window keeps the state alive.
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const inSidebar = (node: EventTarget | null): boolean =>
        node instanceof Element && !!node.closest(".svc-side-bar");
    const onFocusIn = (ev: FocusEvent): void => {
        if (inSidebar(ev.target) && blurTimer !== undefined) {
            clearTimeout(blurTimer);
            blurTimer = undefined;
        }
    };
    const onFocusOut = (ev: FocusEvent): void => {
        if (!inSidebar(ev.target)) return;
        if (blurTimer !== undefined) clearTimeout(blurTimer);
        blurTimer = setTimeout(() => {
            blurTimer = undefined;
            if (!disposed) send({ pgFocus: null });
        }, PG_BLUR_DEBOUNCE_MS);
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);

    // --- mouse ------------------------------------------------------------------
    let lastCurKey = "";
    let mouseTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingMouse: MouseEvent | null = null;

    const captureMouse = (ev: MouseEvent): void => {
        const root = creator.rootElement;
        const target = ev.target;
        if (!root || !(target instanceof Element) || !root.contains(target)) return;
        const tabId = creator.activeTabId ?? "";
        const encoded = encodeAnchor(target, tabId);
        if (!encoded) {
            sendCur(null, "");
            return;
        }
        const rect = encoded.el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const clamp = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
        const x = clamp((ev.clientX - rect.left) / rect.width);
        const y = clamp((ev.clientY - rect.top) / rect.height);
        sendCur({ tab: tabId, a: encoded.a, x, y, t: Date.now() }, `${encoded.a.s}|${encoded.a.n ?? ""}|${x}|${y}|${tabId}`);
    };
    const sendCur = (cur: IPresenceState["cur"], key: string): void => {
        if (key === lastCurKey) return;
        lastCurKey = key;
        send({ cur });
    };
    const onMouseMove = (ev: MouseEvent): void => {
        pendingMouse = ev;
        if (mouseTimer !== undefined) return;
        mouseTimer = setTimeout(() => {
            mouseTimer = undefined;
            if (!disposed && pendingMouse) captureMouse(pendingMouse);
            pendingMouse = null;
        }, MOUSE_THROTTLE_MS);
    };
    const hideCursor = (): void => sendCur(null, "");
    const onVisibility = (): void => {
        if (document.visibilityState === "hidden") hideCursor();
    };
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("visibilitychange", onVisibility);

    // mouseleave doesn't bubble — it needs the root itself, which only exists
    // after the framework renders the creator. Poll until it shows up.
    let leaveTarget: HTMLElement | null = null;
    let rootPoll = 0;
    const attachToRoot = (): void => {
        if (disposed) return;
        const root = creator.rootElement;
        if (root) {
            leaveTarget = root;
            root.addEventListener("mouseleave", hideCursor);
            // The tab is already active by now — (re)announce the initial state.
            sendTab();
            sendSelection(creator.selectedElement);
        } else {
            rootPoll = requestAnimationFrame(attachToRoot);
        }
    };
    rootPoll = requestAnimationFrame(attachToRoot);

    return {
        dispose(): void {
            disposed = true;
            cancelAnimationFrame(rootPoll);
            creator.onActiveTabChanged.remove(onTabChanged);
            creator.onElementSelected.remove(onElementSelected);
            creator.onSurveyInstanceCreated.remove(onSurveyInstanceCreated);
            document.removeEventListener("focusin", onFocusIn, true);
            document.removeEventListener("focusout", onFocusOut, true);
            document.removeEventListener("mousemove", onMouseMove, true);
            document.removeEventListener("visibilitychange", onVisibility);
            leaveTarget?.removeEventListener("mouseleave", hideCursor);
            if (blurTimer !== undefined) clearTimeout(blurTimer);
            if (mouseTimer !== undefined) clearTimeout(mouseTimer);
        }
    };
}
