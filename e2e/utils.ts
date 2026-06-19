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

/**
 * Open the Logic tab and wait until its rule list has rendered.
 *
 * The tab button is `#tab-logic` (TabbedMenu renders `id={"tab-" + item.id}`).
 * The Logic tab keeps its own snapshot model that is built on activation, so we
 * wait for the rules matrix (`.sl-table`) before interacting.
 */
export async function openLogicTab(page: Page): Promise<void> {
    await page.locator("#tab-logic").click();
    await expect(page.locator(".svc-logic-tab .sl-table").first()).toBeVisible();
}

/**
 * A logic rule's row in the rules matrix, located by a substring of its
 * human-readable summary (e.g. the target question name `'q2'`). Scoping by
 * text lets a test address a specific rule without depending on row order.
 */
export function logicRuleRow(page: Page, match: string): Locator {
    return page.locator(".sl-table__row").filter({ hasText: match }).first();
}

/**
 * The display-text element of a logic rule row. The Logic matrix renders each
 * rule's human-readable summary (e.g. "If 'q1' == 1, make question 'q2'
 * visible") as a `svc-link-value-button` span. Its text is the most stable
 * cross-client signal that the rule list rebuilt, so tests assert on it.
 *
 * Pass `match` (e.g. `'q2'`) to target a specific rule; omit it for the first.
 */
export function logicRuleText(page: Page, match?: string): Locator {
    if (match === undefined) return page.locator(".sl-table .svc-link-value-button").first();
    return logicRuleRow(page, match).locator(".svc-link-value-button").first();
}

/**
 * Open a rule's modal detail editor by clicking its row "Show Details" toggle.
 * The toggle's title flips to "Hide Details" once expanded. Pass `match` to
 * pick a specific rule's row; omit it for the first row.
 */
export async function openLogicRuleDetail(page: Page, match?: string): Promise<void> {
    const scope = match === undefined ? page : logicRuleRow(page, match);
    await scope.locator('button[title="Show Details"]').first().click();
    await expect(page.locator('button[title="Hide Details"]').first()).toBeVisible();
}

/** Collapse the open rule detail editor (returns the model to "view" mode). */
export async function closeLogicRuleDetail(page: Page): Promise<void> {
    await page.locator('button[title="Hide Details"]').first().click();
}

/**
 * The condition's value `<input>` inside the rule detail editor's condition
 * builder (the `svc-logic-question-value` question). With a single condition
 * there is exactly one such input; it holds the right-hand comparison value.
 */
export function logicConditionValueInput(page: Page): Locator {
    return page.locator(".svc-logic-question-value input").first();
}

/**
 * Set the condition's right-hand value in the open rule detail editor. The
 * value is a survey text question that commits on BLUR, so a bare `fill`
 * followed by clicking "Done" loses the edit — we explicitly blur first.
 */
export async function setLogicConditionValue(page: Page, value: string): Promise<void> {
    const input = logicConditionValueInput(page);
    await input.click();
    await input.fill(value);
    await input.blur();
}

/** The "Done" button that commits the edited rule and closes the detail editor. */
export function logicDoneButton(page: Page): Locator {
    return page.getByRole("button", { name: "Done", exact: true });
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
