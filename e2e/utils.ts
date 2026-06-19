import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Open a collaboration session in `page` and wait until the WebSocket is open
 * and the server's `init` frame (survey schema + undo/redo stack) has arrived.
 *
 * Readiness is detected at the PROTOCOL level (the init WS frame), not via the
 * on-screen connection bar — that bar is a temporary UI we deliberately do not
 * bind tests to. Receiving the init frame also proves the socket is OPEN, which
 * matters because the client silently drops outbound edits made before the
 * socket opens (see CollabClient.sendSync).
 */
export async function openSession(page: Page, sessionId: string): Promise<void> {
    // Register the frame listener BEFORE navigating so we never miss the init
    // frame, which the server sends immediately on connect. Attaching a
    // waiter after the websocket has already opened would race that frame.
    const initReceived = new Promise<void>((resolve) => {
        page.on("websocket", (ws) => {
            if (!ws.url().includes("/ws/sessions/")) return;
            ws.on("framereceived", (frame) => {
                if (typeof frame.payload === "string" && frame.payload.includes("\"type\":\"init\"")) {
                    resolve();
                }
            });
        });
    });
    await page.goto("/" + sessionId);
    await initReceived;
    // The Creator has mounted once the toolbox is interactive. Toolbox items
    // render as icon-only buttons (their title spans are visually hidden), so
    // we target them by accessible name rather than by CSS class.
    await expect(toolboxItem(page, "Single-Line Input")).toBeVisible();
}

/**
 * A toolbox tool, scoped to the toolbox by its accessible (English) name. We
 * scope to `.svc-toolbox__item` because once a question of the same type exists
 * on the surface, its type-indicator button shares the accessible name.
 */
function toolboxItem(page: Page, name: string): Locator {
    return page.locator(`.svc-toolbox__item[aria-label="${name}"]`).filter({ visible: true }).first();
}

/**
 * Add a single-line text question to the current page. On an empty survey this
 * produces a question named "question1".
 */
export async function addFirstQuestion(page: Page): Promise<void> {
    await toolboxItem(page, "Single-Line Input").click();
}

/** Locator for a question on the design surface, by its survey-element name. */
export function questionLocator(page: Page, name: string): Locator {
    return page.locator(`[data-sv-drop-target-survey-element="${name}"]`);
}

/**
 * The "convert to" question-TYPE dropdown button on a question's adorner.
 * A text-family question renders two convert dropdowns that share the
 * `svc-dropdown-action--convertTo` class — the question type ("Single-Line
 * Input") and the input subtype ("Text") — so we take the first, which is
 * always the type dropdown. Its accessible name is the toolbox title of the
 * question's current type (e.g. "Single-Line Input" for `text`, "Long Text"
 * for `comment`), so it doubles as an assertable signal of the current type.
 */
export function questionTypeButton(page: Page, name: string): Locator {
    return questionLocator(page, name)
        .locator(".svc-dropdown-action--convertTo button")
        .first();
}

/**
 * Convert an existing question to another type via the design-surface
 * type-indicator dropdown. `targetType` is the English toolbox title
 * (e.g. "Long Text", "Checkboxes").
 *
 * Two quirks of this Creator's convert dropdown drive the implementation:
 *   1. The dropdown opens from the action *wrapper* (`.svc-dropdown-action--convertTo`),
 *      not the inner `<button>` — a click on the bare button does not toggle it.
 *   2. The opened popup auto-closes after a few hundred ms (an action-bar reflow
 *      dismisses it), so a "click, then later find the item" sequence loses the
 *      race. We therefore open the popup AND click the item inside one
 *      `expect(...).toPass()` retry, so a click lands while the popup is open.
 *
 * The popup is a menu (`role="menu"`); each type is a `menuitemradio` whose
 * accessible name is the toolbox title — so we target it by role + name.
 */
export async function changeQuestionType(page: Page, name: string, targetType: string): Promise<void> {
    const trigger = questionLocator(page, name).locator(".svc-dropdown-action--convertTo").first();
    const item = page.getByRole("menuitemradio", { name: targetType, exact: true });
    await expect(async () => {
        await trigger.click();
        await item.click({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
}

/**
 * The input-subtype dropdown button on a text-family question's adorner. This
 * is the SECOND convert dropdown — the action bar marks the last of the two
 * convert dropdowns with `svc-dropdown-action--convertTo-last`, which on a
 * text question is the input-type one (the first/unmarked one being the
 * question-type dropdown, see questionTypeButton). Its accessible name is the
 * current input type (e.g. "Text", "Email") and updates reactively, so it
 * doubles as an assertable signal of the input subtype.
 */
export function questionInputTypeButton(page: Page, name: string): Locator {
    return questionLocator(page, name)
        .locator(".svc-dropdown-action--convertTo-last button")
        .first();
}

/**
 * Change a text-family question's input subtype via the design-surface
 * input-type dropdown. `targetInputType` is the English menu label
 * (e.g. "Email", "Number", "Date"). Uses the same open-and-click-in-one-retry
 * dance as changeQuestionType because the popup auto-closes after a moment.
 */
export async function changeInputType(page: Page, name: string, targetInputType: string): Promise<void> {
    const trigger = questionLocator(page, name).locator(".svc-dropdown-action--convertTo-last").first();
    const item = page.getByRole("menuitemradio", { name: targetInputType, exact: true });
    await expect(async () => {
        await trigger.click();
        await item.click({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
}

/**
 * Add a translation language via the Translations-tab sidebar "Add Language"
 * dropdown. `languageName` is the language's NATIVE display name as shown both in
 * the dropdown and afterwards in the language list (e.g. "Français", "Deutsch").
 *
 * The control is the title action of the sidebar "Languages" matrix; its button
 * carries `title="Add Language"` (the English editor-locale tooltip). The popup is
 * a menu of `role="menuitem"` entries named by native language name. Unlike the
 * design-surface convert dropdowns it stays open until a selection or an outside
 * click, so a single click opens it and we then click the language entry (whose
 * accessible name is unique to this popup, so no extra scoping is needed).
 */
export async function addLanguage(page: Page, languageName: string): Promise<void> {
    await page.locator('button[title="Add Language"]').first().click();
    await page.getByRole("menuitem", { name: languageName, exact: true }).click();
}

/** The Undo toolbar button (action-bar). */
export function undoButton(page: Page): Locator {
    return page.getByRole("button", { name: "Undo", exact: true });
}

/** The Redo toolbar button (action-bar). */
export function redoButton(page: Page): Locator {
    return page.getByRole("button", { name: "Redo", exact: true });
}

export async function undo(page: Page): Promise<void> {
    await undoButton(page).click();
}

export async function redo(page: Page): Promise<void> {
    await redoButton(page).click();
}
