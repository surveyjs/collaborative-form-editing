import { test, expect } from "@playwright/test";
import { createRoom, openRoom, uniqueRoomId } from "./utils";

const SEED = {
    pages: [{
        name: "page1",
        elements: [{ type: "text", name: "question1", title: "Q1" }]
    }]
};

test.describe("translation tab", () => {
    // Wide viewport so the tabbed menu shows all tabs inline (the collab status
    // bar eats vertical space and a narrow width collapses tabs into an
    // overflow popup, hiding #tab-translation).
    test.use({ viewport: { width: 1680, height: 1000 } });

    test("languages can be added (locales are registered)", async ({ page }) => {
        const roomId = uniqueRoomId("i18n");
        await createRoom(page, roomId, SEED);
        await openRoom(page, "react", roomId);

        await page.locator("#tab-translation").click();
        // The Add Language dropdown must offer the bundled locales — it is empty
        // when the survey-core/survey-creator-core i18n bundles are not imported.
        await page.locator('button[title="Add Language"]').first().click();
        await page.getByRole("menuitem", { name: "Deutsch", exact: true }).click();

        // The language shows up in the sidebar language list...
        await expect(page.getByText("Deutsch").first()).toBeVisible();
        // ...and a translation row for it appears in the strings grid.
        await expect(page.locator(".st-body").getByText("Deutsch").first()).toBeVisible();
    });
});
