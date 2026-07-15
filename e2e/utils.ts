import { expect, type Locator, type Page } from "@playwright/test";

/** The four client apps, addressed by their URL prefix. */
export const CLIENTS = ["react", "angular", "vue", "js"] as const;
export type ClientName = (typeof CLIENTS)[number];

/** Create a room through the HTTP API (fails the test on unexpected status). */
export async function createRoom(page: Page, roomId: string, seed?: unknown): Promise<void> {
    const res = await page.request.post("/api/rooms", { data: { roomId, seed: seed ?? {} } });
    expect([201, 409]).toContain(res.status());
}

/**
 * Open a room in `page` with the given client app and wait until the WebSocket
 * `init` frame has arrived AND the Creator UI is interactive (toolbox visible).
 *
 * Readiness is detected at the PROTOCOL level (the init WS frame), not via the
 * on-screen connection bar. Receiving init also proves the socket is OPEN,
 * which matters because the collab client drops outbound edits made before the
 * bootstrap completes (see shared/collab-client.ts `ready` gate).
 */
export async function openRoom(page: Page, client: ClientName, roomId: string): Promise<void> {
    // Register the frame listener BEFORE navigating so we never miss the init
    // frame, which the server sends immediately on connect.
    const initReceived = new Promise<void>((resolve) => {
        page.on("websocket", (ws) => {
            if (!ws.url().includes("/ws/rooms/")) return;
            ws.on("framereceived", (frame) => {
                if (typeof frame.payload === "string" && frame.payload.includes("\"type\":\"init\"")) {
                    resolve();
                }
            });
        });
    });
    await page.goto(`/${client}/?room=${encodeURIComponent(roomId)}`);
    await initReceived;
    await expect(toolboxItem(page, "Single-Line Input")).toBeVisible();
}

/**
 * A toolbox tool, scoped to the toolbox by its accessible (English) name. We
 * scope to `.svc-toolbox__item` because once a question of the same type exists
 * on the surface, its type-indicator button shares the accessible name.
 */
export function toolboxItem(page: Page, name: string): Locator {
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
 * The "convert to" question-TYPE dropdown button on a question's adorner. Its
 * accessible name is the toolbox title of the question's current type (e.g.
 * "Single-Line Input" for `text`, "Long Text" for `comment`), so it doubles as
 * an assertable signal of the current type.
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
 * The dropdown opens from the action wrapper (not the inner button), and the
 * opened popup auto-closes after a few hundred ms — so we open AND click
 * inside one `toPass` retry, so a click lands while the popup is open.
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
 * The input-subtype dropdown button on a text-family question's adorner (the
 * SECOND convert dropdown, marked `--convertTo-last`). Its accessible name is
 * the current input type (e.g. "Text", "Email") and updates reactively.
 */
export function questionInputTypeButton(page: Page, name: string): Locator {
    return questionLocator(page, name)
        .locator(".svc-dropdown-action--convertTo-last button")
        .first();
}

/** Change a text question's input subtype (e.g. to "Email"). */
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
 */
export async function addLanguage(page: Page, languageName: string): Promise<void> {
    await page.locator('button[title="Add Language"]').first().click();
    await page.getByRole("menuitem", { name: languageName, exact: true }).click();
}

/**
 * Open the Logic tab and wait until its rule list has rendered. The Logic tab
 * keeps its own snapshot model that is built on activation, so we wait for the
 * rules matrix (`.sl-table`) before interacting.
 */
export async function openLogicTab(page: Page): Promise<void> {
    await page.locator("#tab-logic").click();
    await expect(page.locator(".svc-logic-tab .sl-table").first()).toBeVisible();
}

/**
 * A logic rule's row in the rules matrix, located by a substring of its
 * human-readable summary (e.g. the target question name `'q2'`).
 */
export function logicRuleRow(page: Page, match: string): Locator {
    return page.locator(".sl-table__row").filter({ hasText: match }).first();
}

/**
 * The display-text element of a logic rule row (the rule's human-readable
 * summary, e.g. "If 'q1' == 1, make question 'q2' visible"). Its text is the
 * most stable cross-client signal that the rule list rebuilt.
 * Pass `match` (e.g. `'q2'`) to target a specific rule; omit it for the first.
 */
export function logicRuleText(page: Page, match?: string): Locator {
    if (match === undefined) return page.locator(".sl-table .svc-link-value-button").first();
    return logicRuleRow(page, match).locator(".svc-link-value-button").first();
}

/**
 * Open a rule's detail editor by clicking its row "Show Details" toggle.
 * Pass `match` to pick a specific rule's row; omit it for the first row.
 */
export async function openLogicRuleDetail(page: Page, match?: string): Promise<void> {
    const scope = match === undefined ? page : logicRuleRow(page, match);
    await scope.locator('button[title="Show Details"]').first().click();
    await expect(page.locator('button[title="Hide Details"]').first()).toBeVisible();
}

/**
 * The condition's value `<input>` inside the rule detail editor's condition
 * builder. With a single condition there is exactly one such input; it holds
 * the right-hand comparison value.
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

/** Unique room id per test run. */
export function uniqueRoomId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
