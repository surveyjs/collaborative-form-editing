import type { ISyncMessage } from "@collab/shared";

/**
 * The refresh work the Logic tab needs after a remote sync message was applied
 * to the live survey:
 *   - "rebuild": rebuild the whole tab model now (`model.update()`).
 *   - "defer": the local user is currently inside the modal logic-item editor
 *     (mode !== "view"). A `model.update()` would destroy their in-progress
 *     (unsaved) rule, so we postpone the rebuild until they return to the list.
 *
 * Unlike the Translations tab — an always-live inline matrix with a public
 * soft-refresh (`updateStringsSurveyData`) — the Logic tab edits ONE item at a
 * time in a detail editor and exposes only the full `update()`. So the "don't
 * clobber the local edit" invariant is satisfied by deferring the rebuild, not
 * by a soft merge.
 */
export type LogicRefreshPlan =
    | { kind: "rebuild" }
    | { kind: "defer" };

/**
 * Decide the refresh for a freshly-applied remote message.
 *
 * Kept pure (no survey-core import) so it is trivially unit-testable: the caller
 * passes whether the local user is mid-edit.
 *
 * Correctness over cheapness (as in the Translations planner: "rebuild to stay
 * correct"). Any applied message — property edit, array insert/delete, or
 * undo/redo — can change the rules the tab lists or their display text, so in
 * view mode we always rebuild. We deliberately do NOT filter by locator: an
 * incomplete allowlist would leave the list stale (worse than a redundant
 * rebuild).
 *
 * @param ctx.isEditing the local model's `mode` is not "view" (a logic item is
 *                       open in the detail editor).
 */
export function planLogicRefresh(
    _message: ISyncMessage,
    ctx: { isEditing: boolean }
): LogicRefreshPlan {
    return ctx.isEditing ? { kind: "defer" } : { kind: "rebuild" };
}

/**
 * Apply a plan to a live `SurveyLogicUI` model. Extracted (and exported) so it
 * can be exercised by a jsdom integration test against a real model.
 *
 * Returns `true` when the rebuild was deferred, so the caller can remember to
 * flush it once the user leaves the editor (mode -> "view").
 */
export function applyLogicRefresh(model: any, plan: LogicRefreshPlan): boolean {
    if (plan.kind === "rebuild") {
        model.update?.();
        return false;
    }
    return true; // deferred
}
