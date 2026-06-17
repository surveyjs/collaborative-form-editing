import type { ISyncMessage } from "@collab/shared";

/**
 * Decide whether a freshly-applied remote sync message changed the *structure*
 * the Translations tab renders (rows or locale columns) — which requires a full
 * `Translation.reset()` — versus only the *value* of existing cells, which the
 * lighter `Translation.updateStringsSurveyData()` can pick up in place.
 *
 * Kept pure (no survey-core import) so it is cheap to unit-test: callers supply
 * the model's current locale columns (`["", "en", ...]`, where `""` is the
 * default-locale column) and the set of registered locale codes (from
 * `surveyLocalization.getLocales()`).
 */
export function messageNeedsTranslationRebuild(
    message: ISyncMessage,
    columns: readonly string[],
    localeCodes: ReadonlySet<string>
): boolean {
    // undo/redo are sent as `{ kind, id }` with no action payload, so we can't
    // tell a value revert from a structural one — rebuild to stay correct.
    // These are far rarer than edits.
    if (message.kind !== "transaction") return true;
    for (const action of message.actions) {
        // Array insert/delete adds or removes a translatable element -> a row.
        if (action.kind === "array") return true;
        // Localizable edits encode the locale as the final locator segment
        // ("default" stands for the default locale). Anything else is a
        // non-string property change (e.g. a `name` rename that relabels rows).
        const seg = action.locator.split("/").pop() || "";
        const isLocaleSeg = seg === "default" || localeCodes.has(seg);
        if (!isLocaleSeg) return true;
        const column = seg === "default" ? "" : seg;
        // Editing a locale that has no column yet needs the column added.
        if (columns.indexOf(column) < 0) return true;
    }
    return false;
}
