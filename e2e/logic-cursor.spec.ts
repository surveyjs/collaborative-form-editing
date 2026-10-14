import { expect, test, type Locator, type Page } from "@playwright/test";
import { createRoom, openLogicRuleDetail, openLogicTab, openRoom, uniqueRoomId } from "./utils";

// Remote cursors on the Logic tab. The rule editor and a rule being created
// exist only in each participant's own Logic tab, so a cursor is shared only
// over the summary row of an existing rule - and lands on that rule's row,
// not on whatever sits at the same spot of the receiver's list.

const SEED = {
    pages: [{
        name: "p1",
        elements: [
            { type: "text", name: "q1" },
            // Row order: q3's rule first, q2's second.
            { type: "text", name: "q3", visibleIf: "{q1} = 9" },
            { type: "text", name: "q2", visibleIf: "{q1} = 1" }
        ]
    }]
};

async function openTwo(page: Page, context: any, prefix: string): Promise<{ alice: Page, bob: Page }> {
    const roomId = uniqueRoomId(prefix);
    await createRoom(page, roomId, SEED);
    const alice = page;
    await openRoom(alice, "react", roomId, "Alice");
    const bob = await context.newPage();
    await openRoom(bob, "react", roomId, "Bob");
    await openLogicTab(alice);
    await openLogicTab(bob);
    return { alice, bob };
}

async function addRule(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Add New Rule" }).click();
    await expect(page.locator(".sl-table__row--detail")).toHaveCount(1);
}

// A rule's summary row - never the detail row of an open editor, whose
// controls may mention the same question.
const ruleRow = (page: Page, match: string): Locator =>
    page.locator(".sl-table__row:not(.sl-table__row--detail)").filter({ hasText: match }).first();

const box = (locator: Locator) => locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
});

// Hover the point at fractions (fx, fy) of `target`'s box; waits out the
// capture throttle (50ms) + wire coalescing (40ms) + paint.
async function hover(page: Page, target: Locator, fx: number, fy: number): Promise<void> {
    const b = await box(target);
    await page.mouse.move(b.left + b.width * fx, b.top + b.height * fy, { steps: 3 });
    await page.waitForTimeout(250);
}

const bobsCursor = (page: Page): Locator => page.locator(".collab-presence-cursor-name", { hasText: "Bob" });

test.describe("logic cursor", () => {
    test("two participants adding a rule each see no cursor over their own draft", async ({ page, context }) => {
        const { alice, bob } = await openTwo(page, context, "lg-cur-draft");
        await addRule(alice);
        await addRule(bob);

        // Sanity: over an existing rule's row Bob's cursor does reach Alice.
        await expect(async () => {
            await hover(bob, ruleRow(bob, "'q2'"), 0.3, 0.5);
            await expect(bobsCursor(alice)).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 20_000 });

        // Inside his own draft's editor it must not show up in Alice's draft.
        await hover(bob, bob.locator(".sl-table__row--detail"), 0.5, 0.5);
        await expect(bobsCursor(alice)).toBeHidden();
    });

    test("a cursor over a rule's row lands on that rule's row of a peer who has another rule open", async ({ page, context }) => {
        const { alice, bob } = await openTwo(page, context, "lg-cur-row");
        // Alice's open editor of q3's rule pushes q2's row far down her list;
        // Bob has nothing open, so the two lists differ in layout.
        await openLogicRuleDetail(alice, "'q3'");
        // The editor pushes q2's row below Alice's scroll viewport, where
        // cursors hide by design - bring it into view.
        await ruleRow(alice, "'q2'").scrollIntoViewIfNeeded();

        await expect(async () => {
            await hover(bob, ruleRow(bob, "'q2'"), 0.3, 0.5);
            const row = await box(ruleRow(alice, "'q2'"));
            // NOT toBeVisible(): the cursor node is a 0x0 box whose SVG
            // overflows it, and Playwright treats empty boxes as hidden.
            const got = await alice.locator(".collab-presence-cursor").evaluate((el) => ({
                display: (el as HTMLElement).style.display,
                x: parseFloat((el as HTMLElement).style.left),
                y: parseFloat((el as HTMLElement).style.top)
            }));
            expect(got.display).toBe("block");
            // Fractions are wire-rounded to 3 decimals, the cursor sits on whole pixels.
            expect(Math.abs(got.x - (row.left + row.width * 0.3))).toBeLessThanOrEqual(3);
            expect(Math.abs(got.y - (row.top + row.height * 0.5))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 20_000 });
    });
});
