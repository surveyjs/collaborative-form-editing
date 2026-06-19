import { test, expect } from "@playwright/test";
import {
    openSession,
    openLogicTab,
    logicRuleText,
    openLogicRuleDetail,
    logicConditionValueInput,
    setLogicConditionValue,
    logicDoneButton
} from "./utils";

// A survey that already carries one logic rule: q2 is visible when {q1} == 1.
// Seeding the rule via the server API means both clients' Logic tabs render a
// rule row immediately, so the sync can be exercised without first authoring a
// rule through the modal editor.
const ONE_RULE_SCHEMA = {
    pages: [
        {
            name: "page1",
            elements: [
                { type: "text", name: "q1" },
                { type: "text", name: "q2", visibleIf: "{q1} = 1" }
            ]
        }
    ]
};

// Two independent rules. They MUST use different conditions: the Logic tab
// groups actions by expression, so two questions sharing "{q1} = 1" would merge
// into a single rule row. Distinct conditions (q2: == 1, q3: == 9) keep them as
// two rows, so one client can edit one rule while the other edits the other,
// and the deferred refresh is observable without the editors clobbering a field.
const TWO_RULE_SCHEMA = {
    pages: [
        {
            name: "page1",
            elements: [
                { type: "text", name: "q1" },
                { type: "text", name: "q2", visibleIf: "{q1} = 1" },
                { type: "text", name: "q3", visibleIf: "{q1} = 9" }
            ]
        }
    ]
};

test.describe("collaborative logic sync", () => {
    // Wide viewport so the tabbed menu shows #tab-logic inline (the collab
    // ConnectionBar eats vertical space; a narrow width collapses tabs into an
    // overflow popup).
    test.use({ viewport: { width: 1680, height: 1000 } });

    // The Logic tab keeps its own snapshot model (a list of rules) that only
    // rebuilds on activation. A remote rule edit applied to the live survey must
    // refresh that list on the OTHER client while it sits in the Logic tab.
    test("a remote rule edit refreshes the other client's rule list", async ({ page, context, request }) => {
        const created = await request.post("/api/sessions", { data: { schema: ONE_RULE_SCHEMA } });
        expect(created.ok()).toBeTruthy();
        const { sessionId } = await created.json();

        const tabA = page;
        const tabB = await context.newPage();
        await openSession(tabA, sessionId);
        await openSession(tabB, sessionId);

        await openLogicTab(tabA);
        await openLogicTab(tabB);

        // Both show the seeded rule.
        await expect(logicRuleText(tabA)).toContainText("== 1");
        await expect(logicRuleText(tabB)).toContainText("== 1");

        // A edits the rule's condition value 1 -> 2 and commits (Done) ->
        // broadcasts a visibleIf change.
        await openLogicRuleDetail(tabA);
        await setLogicConditionValue(tabA, "2");
        await logicDoneButton(tabA).click();

        // A's own list reflects the edit.
        await expect(logicRuleText(tabA)).toContainText("== 2");

        // B is in view mode: refreshLogicTab rebuilds its list, so the rule row
        // now shows the synced value.
        await expect(logicRuleText(tabB)).toContainText("== 2");
    });

    // While the local user is editing one rule, a remote edit to a DIFFERENT
    // rule must not disturb their open editor or wipe their in-progress value:
    // the rebuild is deferred until they save, then flushed -- merging both
    // edits.
    test("a remote edit does not disturb the rule the other client is editing, and merges on save", async ({ page, context, request }) => {
        const created = await request.post("/api/sessions", { data: { schema: TWO_RULE_SCHEMA } });
        expect(created.ok()).toBeTruthy();
        const { sessionId } = await created.json();

        const tabA = page;
        const tabB = await context.newPage();
        await openSession(tabA, sessionId);
        await openSession(tabB, sessionId);

        await openLogicTab(tabA);
        await openLogicTab(tabB);
        // The q2 rule (the one A will edit) starts at "== 1" on B.
        await expect(logicRuleText(tabB, "'q2'")).toContainText("== 1");

        // B opens the q3 rule and changes its value 9 -> 7, but does NOT save:
        // the edit is in-progress in the detail editor.
        await openLogicRuleDetail(tabB, "'q3'");
        await setLogicConditionValue(tabB, "7");
        await expect(logicConditionValueInput(tabB)).toHaveValue("7");

        // A edits the q2 rule's value 1 -> 3 and commits -> broadcasts to B.
        await openLogicRuleDetail(tabA, "'q2'");
        await setLogicConditionValue(tabA, "3");
        await logicDoneButton(tabA).click();
        await expect(logicRuleText(tabA, "'q2'")).toContainText("== 3");

        // B's editor is untouched: still open, in-progress value preserved, and
        // the rule list behind it is NOT rebuilt mid-edit (q2 row still "== 1").
        await expect(logicConditionValueInput(tabB)).toHaveValue("7");
        await expect(tabB.locator('button[title="Hide Details"]').first()).toBeVisible();
        await expect(logicRuleText(tabB, "'q2'")).toContainText("== 1");

        // B saves its q3 edit (Done): the deferred rebuild flushes, merging both
        // edits -- A's q2 change AND B's own q3 change appear on B.
        await logicDoneButton(tabB).click();
        await expect(logicRuleText(tabB, "'q3'")).toContainText("== 7");
        await expect(logicRuleText(tabB, "'q2'")).toContainText("== 3");
    });
});
