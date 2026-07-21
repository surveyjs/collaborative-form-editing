/// <reference types="vite/client" />
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { JournalPlugin, PresencePlugin } from "survey-creator-core";
import { SurveyCreator } from "survey-creator-js";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../shared/collab-client";
import { initStatusBar, peersToParticipants } from "../../../shared/status-bar";

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
    // Captures focus/selection/cursor and renders remote peers; the transport
    // below only ships its opaque state (the server stamps name/color on it).
    const presence = new PresencePlugin(creator);
    creator.addPlugin("presence", presence);

    const bar = initStatusBar(document.getElementById("bar")!, "Plain JS", roomId);

    connectCollab({
        creator, plugin, presence, roomId,
        name: getDisplayName(),
        onStatus: (s) => bar.setStatus(s),
        onPresence: (peers) => bar.setParticipants(peersToParticipants(peers))
    });

    creator.render(document.getElementById("creator")!);
}
