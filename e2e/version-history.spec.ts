import { test, expect, type Locator, type Page } from "@playwright/test";
import { addFirstQuestion, createRoom, openRoom, questionLocator, uniqueRoomId } from "./utils";

/**
 * The "Show Version History" right-docked panel renders the room's journal as a
 * timeline — a highlighted Current Version, named versions (saved snapshots),
 * collapsible "N autosaved versions" groups, and the "Document created" base.
 * All of this lives in the framework-agnostic shared status bar, so one client
 * exercises the UI here; per-framework record PRODUCTION is already covered by
 * live-sync.spec.ts. (The "Save to Version History" action is currently
 * removed from the bar, so named versions are not produced through this UI.)
 */
const panel = (page: Page): ReturnType<Page["locator"]> => page.locator(".svc-floating-panel");

async function openCollabMenu(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Collaboration" }).click();
}
async function openHistory(page: Page): Promise<void> {
    await openCollabMenu(page);
    // The menu is a survey-core popup list, so its entries are menuitems.
    await page.getByRole("menuitem", { name: "Show Version History" }).click();
    await expect(panel(page)).toBeVisible();
}

test.describe("version history — react", () => {
    test("shows the room timeline", async ({ page }) => {
        const roomId = uniqueRoomId("history-react");
        await createRoom(page, roomId);
        await openRoom(page, "react", roomId);

        // Empty room → Current Version + Document created, no edits between them.
        await openHistory(page);
        await expect(page.locator(".svc-version-history__row--current")).toBeVisible();
        await expect(page.locator(".svc-version-history__row--base")).toBeVisible();
        await expect(page.locator(".svc-version-history__row--group")).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeHidden();

        // A local edit → an autosaved group appears (newest group open by default).
        await addFirstQuestion(page);
        await expect(questionLocator(page, "question1")).toBeVisible();

        await openHistory(page);
        await expect(page.locator(".svc-version-history__row--group")).toContainText("autosaved version");
        await expect(page.locator(".svc-version-history__row--change").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeHidden();
    });

    test("panel drags by its header", async ({ page }) => {
        const roomId = uniqueRoomId("history-drag");
        await createRoom(page, roomId);
        await openRoom(page, "react", roomId);
        await openHistory(page);

        const before = (await panel(page).boundingBox())!;
        const handle = (await page.locator(".svc-floating-panel__header").boundingBox())!;
        // Grab the middle of the header (away from the minimize/close buttons)
        // and drag left and down.
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 - 300, handle.y + handle.height / 2 + 40, { steps: 8 });
        await page.mouse.up();

        const after = (await panel(page).boundingBox())!;
        // Moved left by the drag delta; the full-height panel cannot move
        // vertically (clamped to the 12px viewport inset), and keeps its size.
        expect(after.x).toBeCloseTo(before.x - 300, 0);
        expect(after.y).toBeCloseTo(12, 0);
        expect(after.width).toBeCloseTo(before.width, 0);
        expect(after.height).toBeCloseTo(before.height, 0);

        // Escape still closes the floating panel.
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeHidden();
    });

    test("rows say who did what, once, and do not look clickable", async ({ page, context }) => {
        const roomId = uniqueRoomId("history-authors");
        await createRoom(page, roomId);
        const alice = page;
        const bob = await context.newPage();
        await openRoom(alice, "react", roomId, "Alice");
        await openRoom(bob, "react", roomId, "Bob");

        await addFirstQuestion(alice);
        await expect(questionLocator(bob, "question1")).toBeVisible();

        // The toolbox add reaches Bob more than once (the record is refreshed and
        // re-sent once the element settles); the timeline lists it once, signed.
        await openHistory(bob);
        const added = bob.locator(".svc-version-history__row--change", { hasText: "Question \"question1\" added" });
        await expect(added).toHaveCount(1);
        await expect(added.locator(".svc-collab-row__subtitle")).toContainText("Alice");

        // Inert rows keep the arrow; only the group header shows the hand.
        const cursorOf = (locator: Locator): Promise<string> => locator.evaluate((el) => getComputedStyle(el).cursor);
        expect(await cursorOf(added.locator("xpath=ancestor::*[contains(@class,'sv-list__item-body')][1]"))).toBe("default");
        expect(await cursorOf(bob.locator(".svc-version-history__row--group").first())).toBe("pointer");

        // A wider panel, and titles wrap instead of ending in an ellipsis.
        const box = (await panel(bob).boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(480);
        expect(box.width).toBeLessThan(490);
        expect(await added.locator(".svc-collab-row__title").evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("normal");

        // The author's own view says "You".
        await openHistory(alice);
        await expect(alice.locator(".svc-version-history__row--change", { hasText: "Question \"question1\" added" })
            .locator(".svc-collab-row__subtitle")).toContainText("You");
    });

    test("a late joiner sees who made the edits, even after the author left", async ({ page, context }) => {
        const roomId = uniqueRoomId("history-late-author");
        await createRoom(page, roomId);
        const alice = page;
        await openRoom(alice, "react", roomId, "Alice");
        await addFirstQuestion(alice);
        await expect(questionLocator(alice, "question1")).toBeVisible();
        // The edit is in the room log before its author goes.
        await expect.poll(async () => (await (await alice.request.get(`/api/rooms/${roomId}`)).json()).logLength)
            .toBeGreaterThan(0);
        await alice.close();

        // Bob never met Alice: her name reaches him with the log alone.
        const bob = await context.newPage();
        await openRoom(bob, "react", roomId, "Bob");
        await expect(questionLocator(bob, "question1")).toBeVisible();
        await openHistory(bob);
        const added = bob.locator(".svc-version-history__row--change", { hasText: "Question \"question1\" added" });
        // The log holds the add and its re-sends; the timeline lists it once.
        await expect(added).toHaveCount(1);
        await expect(added.locator(".svc-collab-row__subtitle")).toContainText("Alice");
    });
});
