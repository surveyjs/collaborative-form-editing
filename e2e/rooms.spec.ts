import { test, expect } from "@playwright/test";
import { ProtoClient } from "./proto-client";
import {
    addFirstQuestion,
    createRoom,
    openRoom,
    questionLocator,
    uniqueRoomId
} from "./utils";

test.describe("rooms", () => {
    test("late joiner bootstraps from seed + record log, then live-syncs", async ({ page, context }) => {
        const roomId = uniqueRoomId("late");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q_seed", title: "Seed question" }] }]
        });

        // A edits alone first, so the room log is non-empty before B joins.
        const tabA = page;
        await openRoom(tabA, "react", roomId);
        await addFirstQuestion(tabA);
        await expect(questionLocator(tabA, "question1")).toBeVisible();

        // B joins late: must see the seed AND the logged edit.
        const tabB = await context.newPage();
        await openRoom(tabB, "react", roomId);
        await expect(tabB.getByText("Seed question").first()).toBeVisible();
        await expect(questionLocator(tabB, "question1")).toBeVisible();

        // ...and stays live: B's edit reaches A.
        await addFirstQuestion(tabB);
        await expect(questionLocator(tabB, "question2")).toBeVisible();
        await expect(questionLocator(tabA, "question2")).toBeVisible();
    });

    test("rooms are isolated: edits never cross", async ({ page, context }) => {
        const room1 = uniqueRoomId("iso-1");
        const room2 = uniqueRoomId("iso-2");
        await createRoom(page, room1);
        await createRoom(page, room2);

        const tab1 = page;
        const tab2 = await context.newPage();
        await openRoom(tab1, "react", room1);
        await openRoom(tab2, "react", room2);

        await addFirstQuestion(tab1);
        await expect(questionLocator(tab1, "question1")).toBeVisible();

        // Give a would-be leak time to arrive, then assert room2 is untouched.
        await tab2.waitForTimeout(1000);
        await expect(questionLocator(tab2, "question1")).toHaveCount(0);
    });

    test("connecting to an unknown room auto-creates it empty", async ({ page }) => {
        const roomId = uniqueRoomId("auto");
        // No createRoom call — the WS connect must auto-create it.
        await openRoom(page, "react", roomId);
        await expect(page.locator("[data-sv-drop-target-survey-element^=question]")).toHaveCount(0);

        const res = await page.request.get(`/api/rooms/${roomId}`);
        expect(res.status()).toBe(200);
        const info = await res.json();
        expect(info.exists).toBe(true);
        expect(info.clientCount).toBe(1);
    });

    test("the log keeps each record's author after the author leaves", async () => {
        const roomId = uniqueRoomId("log-author");
        const a = await ProtoClient.connect(roomId, "Alice");
        const initA = await a.next((m) => m.type === "init");
        const b = await ProtoClient.connect(roomId, "Bob");
        await b.next((m) => m.type === "init");

        // The relay signs the record with the connection's identity.
        a.send({ type: "append", payload: { hello: 1 } });
        const rec = await b.next((m) => m.type === "record");
        expect(rec).toEqual({ type: "record", from: initA.clientId, name: "Alice", payload: { hello: 1 } });

        // Alice is gone from the room, not from its log.
        a.close();
        await b.next((m) => m.type === "presence-leave" && m.clientId === initA.clientId);
        const c = await ProtoClient.connect(roomId, "Carol");
        const initC = await c.next((m) => m.type === "init");
        expect(initC.log).toEqual([{ from: initA.clientId, name: "Alice", payload: { hello: 1 } }]);

        b.close();
        c.close();
    });
});
