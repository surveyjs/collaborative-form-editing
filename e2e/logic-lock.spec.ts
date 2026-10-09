import { expect, test, type Locator, type Page } from "@playwright/test";
import {
    createRoom,
    logicConditionValueInput,
    logicDoneButton,
    logicRuleRow,
    logicRuleText,
    openLogicRuleDetail,
    openLogicTab,
    openRoom,
    setLogicConditionValue,
    uniqueRoomId
} from "./utils";

// Logic-tab editing locks: an existing rule a participant has open in the
// editor is read-only for everyone else until they close it.

const SEED = {
    pages: [{
        name: "p1",
        elements: [
            { type: "text", name: "q1" },
            // q2's rule is the one the tests lock; q3's stays free.
            { type: "text", name: "q3", visibleIf: "{q1} = 9" },
            { type: "text", name: "q2", visibleIf: "{q1} = 1" }
        ]
    }]
};

// A held rule shows its holder as an avatar chip among the row's own actions,
// in the Remove button's spot and level with the rule text - Remove itself is
// gone while the rule is held. A viewer who opens the rule finds a plate naming
// the holder atop the rule editor (Done is gone).
const holderChip = (page: Page, match: string): Locator =>
    logicRuleRow(page, match).locator(".svc-collab-rule-holder");
const lockPlate = (page: Page): Locator => page.locator(".svc-collab-rule-lock");
const backgroundOf = (locator: Locator): Promise<string> =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);

async function expectHeldBy(page: Page, match: string, name: string): Promise<void> {
    const chip = holderChip(page, match);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("title", `${name} is editing this rule.`);
    await expect(logicRuleRow(page, match).locator(".sl-table__remove-button")).toHaveCount(0);
    const text = (await logicRuleText(page, match).boundingBox())!;
    const c = (await chip.boundingBox())!;
    expect(Math.abs(c.y + c.height / 2 - (text.y + text.height / 2))).toBeLessThanOrEqual(1);
}

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

test.describe("logic lock", () => {
    test("an open rule is read-only for the other participant until it is closed", async ({ page, context }) => {
        const { alice, bob } = await openTwo(page, context, "lg-lock");

        await openLogicRuleDetail(alice, "'q2'");
        await expectHeldBy(bob, "'q2'", "Alice");
        await expect(holderChip(bob, "'q3'")).toHaveCount(0);
        // One person, one color: the rule chip is painted like Alice's chip in
        // the collab bar (both derive the slot from her clientId).
        expect(await backgroundOf(holderChip(bob, "'q2'")))
            .toBe(await backgroundOf(bob.locator('.svc-collab-bar__participant[title*="Alice"]')));

        // Bob can open it and read it, not change or save it - the plate says why.
        await openLogicRuleDetail(bob, "'q2'");
        await expect(lockPlate(bob)).toContainText("Alice is editing this rule.");
        const plate = (await lockPlate(bob).boundingBox())!;
        const condition = (await logicConditionValueInput(bob).boundingBox())!;
        expect(plate.y + plate.height).toBeLessThanOrEqual(condition.y);
        // Set off from the rule text above it, not glued to it.
        const ruleText = (await logicRuleText(bob, "'q2'").boundingBox())!;
        expect(plate.y - (ruleText.y + ruleText.height)).toBeGreaterThanOrEqual(8);
        await expect(logicConditionValueInput(bob)).toHaveValue("1");
        await expect(logicConditionValueInput(bob)).not.toBeEditable();
        await expect(logicDoneButton(bob)).toHaveCount(0);

        // Alice closes the rule without changes - Bob takes it over in place.
        await alice.locator('button[title="Hide Details"]').first().click();
        await expect(logicConditionValueInput(bob)).toBeEditable();
        await expect(logicDoneButton(bob)).toBeVisible();
        await expect(lockPlate(bob)).toBeHidden();
        await expect(holderChip(bob, "'q2'")).toHaveCount(0);
        await expectHeldBy(alice, "'q2'", "Bob");
    });

    test("a viewer's editor closes when the holder saves, showing the saved rule", async ({ page, context }) => {
        const { alice, bob } = await openTwo(page, context, "lg-lock-save");

        await openLogicRuleDetail(alice, "'q2'");
        await expectHeldBy(bob, "'q2'", "Alice");
        await openLogicRuleDetail(bob, "'q2'");
        await expect(logicConditionValueInput(bob)).not.toBeEditable();

        await setLogicConditionValue(alice, "3");
        await logicDoneButton(alice).click();
        await expect(logicRuleText(alice, "'q2'")).toContainText("== 3");

        // Bob's read-only copy went stale: it is closed and the list rebuilt.
        await expect(bob.locator('button[title="Hide Details"]')).toHaveCount(0);
        await expect(logicRuleText(bob, "'q2'")).toContainText("== 3");
        await expect(holderChip(bob, "'q2'")).toHaveCount(0);
    });
});
