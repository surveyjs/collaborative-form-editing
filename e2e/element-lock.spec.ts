import { expect, test, type Page } from "@playwright/test";
import { createRoom, openRoom, questionLocator, uniqueRoomId } from "./utils";

// Editing locks: a question a participant has selected on the designer is
// read-only for everyone else until they select something else.

const SEED = {
    pages: [{
        name: "p1",
        elements: [
            { type: "text", name: "q1", title: "Question 1" },
            { type: "text", name: "q2", title: "Question 2" }
        ]
    }]
};

const ring = (page: Page, name: string) =>
    page.locator(`[data-sv-drop-target-survey-element="${name}"] > .svc-question__content`);
const pgTitle = (page: Page) => page.locator('.svc-side-bar [data-name="title"] textarea');

test.describe("element lock", () => {
    test("a selected question is read-only for the other participant until released", async ({ page, context }) => {
        const roomId = uniqueRoomId("lock");
        await createRoom(page, roomId, SEED);
        const alice = page;
        await openRoom(alice, "react", roomId, "Alice");
        const bob = await context.newPage();
        await openRoom(bob, "react", roomId, "Bob");

        // Alice takes q1.
        await questionLocator(alice, "q1").click();
        await expect(ring(bob, "q1")).toHaveAttribute("data-collab-lock", "on");
        const badge = bob.locator(".collab-presence-badge", { hasText: "Alice" });
        await expect(badge).toBeVisible();
        await expect(badge).toHaveAttribute("title", "Alice is editing");

        // Bob may look: selecting q1 works, its properties are read-only, and
        // the adorner offers no drag handle and no delete/duplicate.
        await questionLocator(bob, "q1").click();
        await expect(ring(bob, "q1")).toHaveClass(/svc-question__content--selected/);
        // A viewer's selection is no lock: Alice sees Bob there, unlocked.
        await expect(alice.locator(".collab-presence-badge", { hasText: "Bob" })).toBeVisible();
        await expect(ring(alice, "q1")).not.toHaveAttribute("data-collab-lock", "on");
        await expect(pgTitle(bob)).not.toBeEditable();
        await expect(questionLocator(bob, "q1").locator(".svc-question__drag-element")).toHaveCount(0);
        await expect(questionLocator(bob, "q1").getByRole("button", { name: "Delete" })).toHaveCount(0);
        await expect(questionLocator(bob, "q1").getByRole("button", { name: "Duplicate" })).toHaveCount(0);

        // ...but not edit inline: the title editor is read-only, typing into
        // it changes nothing.
        const bobTitle = questionLocator(bob, "q1").locator(".svc-string-editor").first();
        await expect(bobTitle).toHaveClass(/svc-string-editor--readonly/);
        await bobTitle.click();
        await bob.keyboard.type("XYZ");
        await expect(questionLocator(bob, "q1")).not.toContainText("XYZ");
        await expect(questionLocator(alice, "q1")).not.toContainText("XYZ");

        // Alice moves on - Bob, still on q1, takes it over.
        await questionLocator(alice, "q2").click();
        await expect(pgTitle(bob)).toBeEditable();
        await expect(bobTitle).not.toHaveClass(/svc-string-editor--readonly/);
        await expect(ring(alice, "q1")).toHaveAttribute("data-collab-lock", "on");
        await expect(alice.locator(".collab-presence-badge", { hasText: "Bob" })).toHaveAttribute("title", "Bob is editing");
        await expect(ring(bob, "q2")).toHaveAttribute("data-collab-lock", "on");

        await pgTitle(bob).fill("Bob's title");
        await pgTitle(bob).press("Tab");
        await expect(questionLocator(alice, "q1")).toContainText("Bob's title");
    });
});
