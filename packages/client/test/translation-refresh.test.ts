import { describe, it, expect } from "vitest";
import { messageNeedsTranslationRebuild } from "../src/translation-refresh";
import type { ISyncMessage } from "@collab/shared";

// Locale codes "registered" with survey-core for these tests. "default" is a
// reserved token (not in this set) and maps to the model's "" column.
const REGISTERED = new Set<string>(["en", "de", "fr", "es"]);
// Columns the Translations tab currently shows: default + en + de.
const COLUMNS = ["", "en", "de"];

function tx(...actions: any[]): ISyncMessage {
    return { kind: "transaction", id: "t1", actions } as ISyncMessage;
}

describe("messageNeedsTranslationRebuild", () => {
    it("uses the light path for a text edit in an existing locale column", () => {
        const msg = tx({ kind: "property", locator: "/pages/0/elements/0/title/de", value: "Titel" });
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(false);
    });

    it("uses the light path for a default-locale text edit", () => {
        const msg = tx({ kind: "property", locator: "/pages/0/elements/0/title/default", value: "Title" });
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(false);
    });

    it("uses the light path when every action is an existing-locale text edit", () => {
        const msg = tx(
            { kind: "property", locator: "/pages/0/elements/0/title/en", value: "Q1" },
            { kind: "property", locator: "/pages/0/elements/1/title/de", value: "Frage 2" }
        );
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(false);
    });

    it("rebuilds when a locale has no column yet (new column)", () => {
        const msg = tx({ kind: "property", locator: "/pages/0/elements/0/title/fr", value: "Titre" });
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(true);
    });

    it("rebuilds on an array action (row added/removed)", () => {
        const msg = tx({ kind: "array", locator: "/pages/0/elements/1", value: [{ type: "text", name: "q2" }] });
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(true);
    });

    it("rebuilds on a non-localizable property change (e.g. a name rename)", () => {
        const msg = tx({ kind: "property", locator: "/pages/0/elements/0/name", value: "renamed" });
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(true);
    });

    it("rebuilds if any action in the transaction is structural", () => {
        const msg = tx(
            { kind: "property", locator: "/pages/0/elements/0/title/de", value: "Titel" },
            { kind: "array", locator: "/pages/0/elements/2", value: null }
        );
        expect(messageNeedsTranslationRebuild(msg, COLUMNS, REGISTERED)).toBe(true);
    });

    it("rebuilds for undo/redo messages (no action payload to classify)", () => {
        expect(messageNeedsTranslationRebuild({ kind: "undo", id: "t1" } as ISyncMessage, COLUMNS, REGISTERED)).toBe(true);
        expect(messageNeedsTranslationRebuild({ kind: "redo", id: "t1" } as ISyncMessage, COLUMNS, REGISTERED)).toBe(true);
    });
});
