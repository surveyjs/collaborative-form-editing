import { test, expect } from "@playwright/test";
import { openSession } from "./utils";

// A survey pre-seeded with two questions (two translatable title strings) so the
// two clients can edit DIFFERENT translation cells. Seeding via the server API
// avoids driving the toolbox, which keeps this test focused on the sync refresh.
const TWO_QUESTION_SCHEMA = {
    pages: [
        {
            name: "page1",
            elements: [
                { type: "text", name: "question1", title: "Q1 title" },
                { type: "text", name: "question2", title: "Q2 title" }
            ]
        }
    ]
};

// A single question whose title already carries `de` and `fr` translations.
// Used-locale detection surfaces both as columns on every client, so two clients
// can edit the SAME field in DIFFERENT languages without driving the sidebar.
const MULTI_LOCALE_SCHEMA = {
    pages: [
        {
            name: "page1",
            elements: [
                { type: "text", name: "question1", title: { default: "Q1", de: "DE0", fr: "FR0" } }
            ]
        }
    ]
};

test.describe("collaborative translation sync", () => {
    // Wide viewport so the tabbed menu shows all tabs inline (the collab
    // ConnectionBar eats vertical space and a narrow width collapses tabs into
    // an overflow popup, hiding #tab-translation).
    test.use({ viewport: { width: 1680, height: 1000 } });

    // While one client is typing into a translation cell, an edit arriving from
    // another client triggers the local Translations-tab refresh
    // (updateStringsSurveyData). That refresh must not steal focus from the cell
    // being edited, nor wipe the in-progress (uncommitted) text in it.
    test("incoming remote edits don't steal focus from the cell being edited", async ({ page, context, request }) => {
        const created = await request.post("/api/sessions", { data: { schema: TWO_QUESTION_SCHEMA } });
        expect(created.ok()).toBeTruthy();
        const { sessionId } = await created.json();

        const tabA = page;
        const tabB = await context.newPage();
        await openSession(tabA, sessionId);
        await openSession(tabB, sessionId);

        // Both switch to the Translations tab (role="tab", id "tab-translation").
        await tabA.locator("#tab-translation").click();
        await tabB.locator("#tab-translation").click();

        // The strings-table cells are the textareas inside `.st-strings`.
        const cellsA = tabA.locator(".st-strings textarea");
        const cellsB = tabB.locator(".st-strings textarea");
        await expect(cellsB.nth(1)).toBeVisible();
        await expect(cellsA.nth(1)).toBeVisible();

        // B starts editing the FIRST cell and does NOT blur (text stays
        // uncommitted in the DOM, mid-edit).
        await cellsB.nth(0).click();
        await cellsB.nth(0).fill("BBBB");
        await expect(cellsB.nth(0)).toBeFocused();

        // A edits a DIFFERENT cell and commits it (blur) -> broadcast to B.
        await cellsA.nth(1).click();
        await cellsA.nth(1).fill("REMOTE_AAAA");
        await cellsA.nth(1).blur();

        // B receives and applies the remote edit into the OTHER cell, proving the
        // refresh (updateStringsSurveyData) ran on B.
        await expect(cellsB.nth(1)).toHaveValue("REMOTE_AAAA");

        // The refresh must NOT have disturbed the cell B is editing: focus and
        // the in-progress text are both preserved.
        await expect(cellsB.nth(0)).toBeFocused();
        await expect(cellsB.nth(0)).toHaveValue("BBBB");
    });

    // Two clients editing the SAME field in DIFFERENT languages at the same time
    // must merge (each locale is an independent edit), and an incoming edit must
    // not wipe the local in-progress edit in another locale's cell.
    test("concurrent edits to the same field in different languages merge", async ({ page, context, request }) => {
        const created = await request.post("/api/sessions", { data: { schema: MULTI_LOCALE_SCHEMA } });
        expect(created.ok()).toBeTruthy();
        const { sessionId } = await created.json();

        const tabA = page;
        const tabB = await context.newPage();
        await openSession(tabA, sessionId);
        await openSession(tabB, sessionId);

        await tabA.locator("#tab-translation").click();
        await tabB.locator("#tab-translation").click();

        const cellsA = tabA.locator(".st-strings textarea");
        const cellsB = tabB.locator(".st-strings textarea");
        // question1's title row: default + de + fr columns -> three cells.
        await expect(cellsA).toHaveCount(3);
        await expect(cellsB).toHaveCount(3);

        // Locate the de/fr cells by their seeded values, so the test does not
        // depend on the column order. The index is the same on both clients.
        const indexOfValue = (cells: typeof cellsA, value: string) =>
            cells.evaluateAll(
                (els, v) => els.findIndex((e) => (e as HTMLTextAreaElement).value === v),
                value
            );
        const deIdx = await indexOfValue(cellsA, "DE0");
        const frIdx = await indexOfValue(cellsA, "FR0");
        expect(deIdx).toBeGreaterThanOrEqual(0);
        expect(frIdx).toBeGreaterThanOrEqual(0);

        // B starts editing the `fr` cell and does NOT blur (in-progress).
        await cellsB.nth(frIdx).click();
        await cellsB.nth(frIdx).fill("FR_B");
        await expect(cellsB.nth(frIdx)).toBeFocused();

        // A edits the `de` cell of the SAME field and commits -> syncs to B.
        await cellsA.nth(deIdx).click();
        await cellsA.nth(deIdx).fill("DE_A");
        await cellsA.nth(deIdx).blur();

        // On B: the de cell shows A's edit (refresh ran) while B's in-progress fr
        // edit and focus are preserved.
        await expect(cellsB.nth(deIdx)).toHaveValue("DE_A");
        await expect(cellsB.nth(frIdx)).toBeFocused();
        await expect(cellsB.nth(frIdx)).toHaveValue("FR_B");

        // B commits its fr edit -> syncs to A.
        await cellsB.nth(frIdx).blur();

        // Both per-locale edits merged on BOTH clients (no clobber).
        await expect(cellsA.nth(deIdx)).toHaveValue("DE_A");
        await expect(cellsA.nth(frIdx)).toHaveValue("FR_B");
        await expect(cellsB.nth(deIdx)).toHaveValue("DE_A");
        await expect(cellsB.nth(frIdx)).toHaveValue("FR_B");
    });
});
