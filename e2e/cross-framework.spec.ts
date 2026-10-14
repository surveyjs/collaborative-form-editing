import { test, expect } from "@playwright/test";
import {
    CLIENTS,
    addFirstQuestion,
    changeQuestionType,
    createRoom,
    openRoom,
    questionLocator,
    questionTypeButton,
    releaseSelection,
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

        // The react tab still has question1 selected - an editing lock that
        // makes it read-only elsewhere - so it lets go before the js tab
        // (last) converts it; converting selects it on the js tab in turn.
        await releaseSelection(tabs[0]);
        await changeQuestionType(tabs[3], "question1", "Checkboxes");
        await releaseSelection(tabs[3]);
        for (const tab of tabs) {
            await expect(questionTypeButton(tab, "question1")).toHaveAccessibleName("Checkboxes");
        }
    });
});
