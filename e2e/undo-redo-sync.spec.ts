import { test, expect } from "@playwright/test";
import {
    addFirstQuestion,
    changeInputType,
    changeQuestionType,
    openSession,
    questionInputTypeButton,
    questionLocator,
    questionTypeButton,
    redo,
    redoButton,
    undo,
    undoButton
} from "./utils";

test.describe("collaborative undo/redo sync", () => {
    test("live edits propagate between two already-connected tabs", async ({ page, context }) => {
        const sessionId = "e2e-live-" + Date.now();
        const tabA = page;
        const tabB = await context.newPage();

        await openSession(tabA, sessionId);
        await openSession(tabB, sessionId);

        await addFirstQuestion(tabA);
        await expect(questionLocator(tabA, "question1")).toBeVisible();
        await expect(questionLocator(tabB, "question1")).toBeVisible();

        await expect(questionInputTypeButton(tabA, "question1")).toHaveAccessibleName("Text");
        await expect(questionInputTypeButton(tabB, "question1")).toHaveAccessibleName("Text");

        await changeInputType(tabA, "question1", "Email");
        await expect(questionInputTypeButton(tabA, "question1")).toHaveAccessibleName("Email");
        await expect(questionInputTypeButton(tabB, "question1")).toHaveAccessibleName("Email");

        await changeQuestionType(tabA, "question1", "Long Text");
        await expect(questionTypeButton(tabA, "question1")).toHaveAccessibleName("Long Text");
        await expect(questionTypeButton(tabB, "question1")).toHaveAccessibleName("Long Text");
    });

    test("late joiner inherits the undo stack and can undo a pre-join edit", async ({ page, context }) => {
        const sessionId = "e2e-join-" + Date.now();
        const tabA = page;

        // Host A edits alone, building one transaction on the shared stack.
        await openSession(tabA, sessionId);
        await addFirstQuestion(tabA);
        await expect(questionLocator(tabA, "question1")).toBeVisible();
        // Let the server apply A's transaction before B joins.
        await tabA.waitForTimeout(500);

        // B joins late.
        const tabB = await context.newPage();
        await openSession(tabB, sessionId);

        // schema sync: B sees A's question from the init snapshot.
        await expect(questionLocator(tabB, "question1")).toBeVisible();

        // stack sync: B's Undo is enabled because it inherited A's transaction
        // via importStack — without the fix this button would be disabled.
        await expect(undoButton(tabB)).toBeEnabled();
        await undo(tabB);

        // B undid A's PRE-JOIN transaction; the rollback reaches both tabs.
        await expect(questionLocator(tabB, "question1")).toHaveCount(0);
        await expect(questionLocator(tabA, "question1")).toHaveCount(0);

        // Redo from B restores the question in both tabs.
        await redo(tabB);
        await expect(questionLocator(tabB, "question1")).toBeVisible();
        await expect(questionLocator(tabA, "question1")).toBeVisible();
    });

    test("fresh session has no history: undo/redo disabled, no console errors", async ({ page }) => {
        const errors: Error[] = [];
        page.on("pageerror", (err) => errors.push(err));

        const sessionId = "e2e-empty-" + Date.now();
        await openSession(page, sessionId);

        // Empty stack imported as a harmless no-op: nothing to undo or redo.
        await expect(undoButton(page)).toBeDisabled();
        await expect(redoButton(page)).toBeDisabled();
        expect(errors).toHaveLength(0);
    });
});
