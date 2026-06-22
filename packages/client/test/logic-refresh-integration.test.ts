import { describe, it, expect } from "vitest";
import { SurveyCreatorModel } from "survey-creator-core";
import { planLogicRefresh, applyLogicRefresh, bindLogicEditEndFlush } from "../src/logic-refresh";
import type { ISyncMessage } from "@collab/shared";

// Exercises the Logic-tab refresh against a real (headless) creator model, the
// same way translation-enable-locale.test.ts does for Translations.

function getLogicModel(creator: SurveyCreatorModel): any {
    creator.activeTab = "logic";
    const plugin: any = creator.getPlugin("logic");
    plugin?.activate?.();
    return plugin.model;
}

// The single logic rule's condition expression, as the model lists it.
function ruleExpression(model: any): string | undefined {
    return model.items?.[0]?.expression;
}

function makeCreator(): SurveyCreatorModel {
    const creator = new SurveyCreatorModel({ showLogicTab: true });
    creator.JSON = {
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
    return creator;
}

const editMsg: ISyncMessage = {
    kind: "transaction",
    id: "t1",
    actions: [{ kind: "property", locator: "/pages/0/elements/1/visibleIf", value: "{q1} = 2" }]
} as ISyncMessage;

describe("logic-tab refresh against a real model", () => {
    it("rebuilds the rule list to reflect a synced expression edit (view mode)", () => {
        const creator = makeCreator();
        const model = getLogicModel(creator);

        // One rule, the seeded condition.
        expect(model.items).toHaveLength(1);
        expect(ruleExpression(model)).toBe("{q1} = 1");

        // Simulate what applySerialized does: mutate the live survey in place.
        creator.survey.getQuestionByName("q2").visibleIf = "{q1} = 2";
        // The snapshot model is still stale until refreshed.
        expect(ruleExpression(model)).toBe("{q1} = 1");

        // Run the client's refresh for a not-editing receiver.
        const plan = planLogicRefresh(editMsg, { isEditing: model.mode !== "view" });
        expect(plan).toEqual({ kind: "rebuild" });
        const deferred = applyLogicRefresh(model, plan);

        expect(deferred).toBe(false);
        expect(ruleExpression(model)).toBe("{q1} = 2");
    });

    it("defers the rebuild while the detail editor is open, then flushes on return to view", () => {
        const creator = makeCreator();
        const model = getLogicModel(creator);

        // Open the rule in the modal detail editor (mode leaves "view").
        model.editItem(model.items[0]);
        expect(model.mode).not.toBe("view");

        // A remote edit arrives and is applied to the live survey...
        creator.survey.getQuestionByName("q2").visibleIf = "{q1} = 2";

        // ...the refresh must DEFER (not rebuild) so the open editor is untouched.
        const plan = planLogicRefresh(editMsg, { isEditing: model.mode !== "view" });
        expect(plan).toEqual({ kind: "defer" });
        const deferred = applyLogicRefresh(model, plan);
        expect(deferred).toBe(true);
        // Still in the editor; the listed rule was not rebuilt out from under it.
        expect(model.mode).not.toBe("view");

        // When the user saves the rule, the deferred rebuild (model.update())
        // surfaces the synced change. In CollaborativeCreator this flush is
        // triggered by the model's `onLogicItemSaved` event (the model's `mode`
        // is a plain getter and cannot be observed); here we invoke the rebuild
        // directly, which is what that handler does.
        model.update();
        expect(ruleExpression(model)).toBe("{q1} = 2");
    });
});

// The real-world scenario: client A starts authoring a BRAND NEW rule (mode
// "new") and, mid-authoring, a *different* new rule arrives from client B and is
// applied to the live survey. The rebuild must defer (A's in-progress editor is
// untouched). The crux: B's rule must surface once A leaves the editor by EITHER
// path — Done (save) or Cancel (collapse) — not only on save.
describe("logic-tab deferred rebuild flushes when A leaves a NEW rule", () => {
    // Mirror CollaborativeCreator's wiring: a pending flag, an idempotent flush,
    // and both edit-end triggers bound to the live model.
    function wireFlush(model: any): { setPending: () => void; isPending: () => boolean } {
        let pending = false;
        const flush = (): void => {
            if (!pending) return;
            pending = false;
            model.update();
        };
        model.onLogicItemSaved.add(flush);
        bindLogicEditEndFlush(model, flush);
        return { setPending: () => { pending = true; }, isPending: () => pending };
    }

    // A remote "insert" message — its content is irrelevant to the planner
    // (which always rebuilds/defers regardless of locator), so any shape does.
    const insertMsg: ISyncMessage = {
        kind: "transaction",
        id: "t2",
        actions: [{ kind: "property", locator: "/pages/0/elements/2/visibleIf", value: "{q1} = 9" }]
    } as ISyncMessage;

    it("CANCEL: B's rule appears after A collapses the unsaved new rule", () => {
        const creator = makeCreator();
        const model = getLogicModel(creator);
        const flush = wireFlush(model);
        expect(model.items).toHaveLength(1); // just the seeded q2 rule

        // A opens a brand new rule in the detail editor.
        model.addNewUI();
        expect(model.mode).toBe("new");

        // B's new rule arrives and is applied to the live survey in place.
        const q3 = creator.survey.pages[0].addNewQuestion("text", "q3");
        q3.visibleIf = "{q1} = 9";

        // Refresh must DEFER: A is mid-edit, so the list is NOT rebuilt and A's
        // open editor survives. B's rule is not yet listed.
        const plan = planLogicRefresh(insertMsg, { isEditing: model.mode !== "view" });
        expect(plan).toEqual({ kind: "defer" });
        if (applyLogicRefresh(model, plan)) flush.setPending();
        expect(flush.isPending()).toBe(true);
        expect(model.mode).toBe("new");
        expect(model.items.some((i: any) => i.expression === "{q1} = 9")).toBe(false);

        // A CANCELS: collapsing the detail panel sets mode -> "view" (no save).
        // The onEndEditing hook flushes the deferred rebuild.
        model.mode = "view";

        expect(flush.isPending()).toBe(false);
        expect(model.mode).toBe("view");
        // B's rule is now present (alongside the seeded q2 rule); A's discarded
        // empty new rule is gone.
        expect(model.items.some((i: any) => i.expression === "{q1} = 9")).toBe(true);
        expect(model.items.some((i: any) => i.expression === "{q1} = 1")).toBe(true);
    });

    it("SAVE: the flush is idempotent across the save double-fire", () => {
        const creator = makeCreator();
        const model = getLogicModel(creator);
        let updates = 0;
        const origUpdate = model.update.bind(model);
        model.update = (...args: any[]): void => { updates++; origUpdate(...args); };
        const flush = wireFlush(model);

        model.editItem(model.items[0]);
        expect(model.mode).not.toBe("view");

        // A remote edit is applied and deferred.
        creator.survey.getQuestionByName("q2").visibleIf = "{q1} = 2";
        const plan = planLogicRefresh(editMsg, { isEditing: model.mode !== "view" });
        if (applyLogicRefresh(model, plan)) flush.setPending();
        expect(flush.isPending()).toBe(true);

        // Save fires BOTH onLogicItemSaved and (via mode->view) onEndEditing.
        // The flush must run exactly once: the second call is a guarded no-op.
        model.onLogicItemSaved.fire(model, { item: model.items[0] });
        model.mode = "view";

        expect(flush.isPending()).toBe(false);
        expect(updates).toBe(1);
        expect(ruleExpression(model)).toBe("{q1} = 2");
    });
});
