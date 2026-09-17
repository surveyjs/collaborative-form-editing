import { test, expect } from "@playwright/test";
import {
    CLIENTS,
    createRoom,
    openRoom,
    questionLocator,
    toolboxItem,
    uniqueRoomId
} from "./utils";

/**
 * A composite added by a peer must show nested content on the receiving
 * designer. CollaborationPlugin applies the add via splice, which used to skip
 * onFirstRendering — the shell appeared, the contentPanel stayed empty.
 */
for (const client of CLIENTS) {
    test.describe(`composite sync — ${client}`, () => {
        test(`nested shippingaddress content appears on the peer ${client} tab`, async ({ page, context }) => {
            const roomId = uniqueRoomId(`composite-${client}`);
            await createRoom(page, roomId);

            const tabA = page;
            const tabB = await context.newPage();
            await openRoom(tabA, client, roomId);
            await openRoom(tabB, client, roomId);

            await toolboxItem(tabA, "Shipping Address").click();
            await expect(questionLocator(tabA, "question1")).toBeVisible();
            const nestedOn = (tab: typeof tabA) =>
                questionLocator(tab, "question1").locator("[data-name='businessAddress']");
            await expect(nestedOn(tabA)).toBeVisible();

            await expect(questionLocator(tabB, "question1")).toBeVisible();
            await expect(nestedOn(tabB)).toBeVisible();
            await expect(questionLocator(tabB, "question1").locator("[data-name='shippingSameAsBusiness']")).toBeVisible();
        });
    });
}
