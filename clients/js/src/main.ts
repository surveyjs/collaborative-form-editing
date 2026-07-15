/// <reference types="vite/client" />
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { JournalPlugin, buildLocator, resolveLocator } from "survey-creator-core";
import { SurveyCreator } from "survey-creator-js";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../shared/collab-client";
import { initPresenceCapture } from "../../../shared/presence-capture";
import { initPresenceOverlay } from "../../../shared/presence-overlay";
import type { IPresenceOverlay } from "../../../shared/presence-overlay";
import { initStatusBar } from "../../../shared/status-bar";

// Baked in at build time from the environment (see envPrefix in vite.config.ts).
if (import.meta.env.SURVEYJS_LICENSE_KEY) slk(import.meta.env.SURVEYJS_LICENSE_KEY);

const roomId = getRoomIdFromUrl();
if (!roomId) {
    location.href = "/";
} else {
    const creator = new SurveyCreator({
        showLogicTab: true,
        showTranslationTab: true,
        showJSONEditorTab: true
    });

    const plugin = new JournalPlugin(creator);
    creator.addPlugin("journal", plugin);

    const bar = initStatusBar(document.getElementById("bar")!, "Plain JS", roomId);

    // Locator functions come from THIS app's survey-creator-core copy — the
    // shared presence modules must not import the library themselves.
    const locator = {
        build: (obj: unknown, survey: unknown): string => buildLocator(obj, survey as never),
        resolve: (loc: string, survey: unknown): unknown => resolveLocator(loc, survey as never)
    };

    let overlay: IPresenceOverlay | undefined;
    const collab = connectCollab({
        creator, plugin, roomId,
        name: getDisplayName(),
        onStatus: (s) => bar.setStatus(s),
        onPresence: (peers) => {
            overlay?.refresh();
            bar.setParticipants([...peers.values()].map((p) => ({
                id: p.clientId, name: p.state.name, color: p.color, tab: p.state.tab
            })));
        }
    });
    initPresenceCapture({ creator, locator, send: (partial) => collab.updatePresence(partial) });
    overlay = initPresenceOverlay({ creator, locator, getPeers: () => collab.getPeers() });

    creator.render(document.getElementById("creator")!);
}
