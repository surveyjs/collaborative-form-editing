import { test, expect } from "@playwright/test";
import {
    CLIENTS,
    addFirstQuestion,
    changeQuestionType,
    createRoom,
    openRoom,
    questionLocator,
    questionTypeButton,
    uniqueRoomId
} from "./utils";

test.describe("cross-framework room", () => {
    test("one room open in all four clients converges on every edit", async ({ page, context }) => {
        const roomId = uniqueRoomId("cross");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q_seed", title: "Seed question" }] }]
        });

        // One tab per client app, all in the same room.
        const tabs = [page, await context.newPage(), await context.newPage(), await context.newPage()];
        for (let i = 0; i < CLIENTS.length; i++) {
            await openRoom(tabs[i], CLIENTS[i], roomId);
            await expect(tabs[i].getByText("Seed question").first()).toBeVisible();
        }

        // The react tab adds a question — every framework applies it.
        await addFirstQuestion(tabs[0]);
        for (const tab of tabs) {
            await expect(questionLocator(tab, "question1")).toBeVisible();
        }

        // The js tab (last) converts it — every framework converges.
        await changeQuestionType(tabs[3], "question1", "Checkboxes");
        for (const tab of tabs) {
            await expect(questionTypeButton(tab, "question1")).toHaveAccessibleName("Checkboxes");
        }
    });
});
