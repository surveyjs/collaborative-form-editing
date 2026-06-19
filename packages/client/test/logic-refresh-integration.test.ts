import { describe, it, expect } from "vitest";
import { SurveyCreatorModel } from "survey-creator-core";
import { planLogicRefresh, applyLogicRefresh } from "../src/logic-refresh";
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
