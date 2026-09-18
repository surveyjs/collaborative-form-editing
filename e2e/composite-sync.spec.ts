import { test, expect, type Page } from "@playwright/test";
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
const nestedOn = (tab: Page, name: string) =>
    questionLocator(tab, "question1").locator(`[data-name='${name}']`);

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
            await expect(nestedOn(tabA, "businessAddress")).toBeVisible();

            await expect(questionLocator(tabB, "question1")).toBeVisible();
            await expect(nestedOn(tabB, "businessAddress")).toBeVisible();
            await expect(nestedOn(tabB, "shippingSameAsBusiness")).toBeVisible();
        });

        // The other apply path: the composite arrives in the init log replay
        // rather than as a live record. Worth running for every client because
        // the timing differs - three of the four connect before the creator is
        // rendered (the replay then predates the first paint), the Angular one
        // connects from ngAfterViewInit, with the designer already painted.
        test(`nested shippingaddress content appears for a late joiner ${client} tab`, async ({ page, context }) => {
            const roomId = uniqueRoomId(`composite-late-${client}`);
            await createRoom(page, roomId);

            const tabA = page;
            await openRoom(tabA, client, roomId);
            await toolboxItem(tabA, "Shipping Address").click();
            await expect(nestedOn(tabA, "businessAddress")).toBeVisible();

            const tabB = await context.newPage();
            await openRoom(tabB, client, roomId);
            await expect(questionLocator(tabB, "question1")).toBeVisible();
            await expect(nestedOn(tabB, "businessAddress")).toBeVisible();
            await expect(nestedOn(tabB, "shippingSameAsBusiness")).toBeVisible();
        });
    });
}
