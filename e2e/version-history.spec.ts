import { test, expect, type Page } from "@playwright/test";
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
const panel = (page: Page): ReturnType<Page["locator"]> => page.locator(".collab-version-panel");

async function openCollabMenu(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Collaboration" }).click();
}
async function openHistory(page: Page): Promise<void> {
    await openCollabMenu(page);
    await page.getByRole("button", { name: "Show Version History" }).click();
    await expect(panel(page)).toBeVisible();
}

test.describe("version history — react", () => {
    test("shows the room timeline", async ({ page }) => {
        const roomId = uniqueRoomId("history-react");
        await createRoom(page, roomId);
        await openRoom(page, "react", roomId);

        // Empty room → Current Version + Document created, no edits between them.
        await openHistory(page);
        await expect(page.locator(".collab-version-current")).toBeVisible();
        await expect(page.locator(".collab-version-base")).toBeVisible();
        await expect(page.locator(".collab-version-group")).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeHidden();

        // A local edit → an autosaved group appears (newest group open by default).
        await addFirstQuestion(page);
        await expect(questionLocator(page, "question1")).toBeVisible();

        await openHistory(page);
        await expect(page.locator(".collab-version-group")).toContainText("autosaved version");
        await expect(page.locator(".collab-version-autosaved").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeHidden();
    });
});
