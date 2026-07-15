import { test, expect } from "@playwright/test";
import {
    CLIENTS,
    addFirstQuestion,
    changeInputType,
    changeQuestionType,
    createRoom,
    openRoom,
    questionInputTypeButton,
    questionLocator,
    questionTypeButton,
    uniqueRoomId
} from "./utils";

/**
 * The same two-tab live-sync scenario, once per client app. The journal
 * records are framework-agnostic, so each framework's Creator must both
 * produce records (tab A edits) and apply them (tab B observes).
 */
for (const client of CLIENTS) {
    test.describe(`live sync — ${client}`, () => {
        test(`edits propagate both ways between two ${client} tabs`, async ({ page, context }) => {
            const roomId = uniqueRoomId(`live-${client}`);
            await createRoom(page, roomId);

            const tabA = page;
            const tabB = await context.newPage();
            await openRoom(tabA, client, roomId);
            await openRoom(tabB, client, roomId);

            // A adds a question → appears in both tabs.
            await addFirstQuestion(tabA);
            await expect(questionLocator(tabA, "question1")).toBeVisible();
            await expect(questionLocator(tabB, "question1")).toBeVisible();

            // A changes the input subtype → replicated to B.
            await changeInputType(tabA, "question1", "Email");
            await expect(questionInputTypeButton(tabA, "question1")).toHaveAccessibleName("Email");
            await expect(questionInputTypeButton(tabB, "question1")).toHaveAccessibleName("Email");

            // B converts the question type → replicated back to A (reverse direction).
            await changeQuestionType(tabB, "question1", "Long Text");
            await expect(questionTypeButton(tabB, "question1")).toHaveAccessibleName("Long Text");
            await expect(questionTypeButton(tabA, "question1")).toHaveAccessibleName("Long Text");
        });
    });
}
