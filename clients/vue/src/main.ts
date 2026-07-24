/// <reference types="vite/client" />
import { createApp, h } from "vue";
import { slk } from "survey-core";
import { CollabBarPlugin, JournalPlugin, PresencePlugin, SurveyCreatorModel } from "survey-creator-core";
import { SurveyCreatorComponent } from "survey-creator-vue";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../shared/collab-client";
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";

// Baked in at build time from the environment (see envPrefix in vite.config.ts).
if (import.meta.env.SURVEYJS_LICENSE_KEY) slk(import.meta.env.SURVEYJS_LICENSE_KEY);

const roomId = getRoomIdFromUrl();
if (!roomId) {
    location.href = "/";
} else {
    const creator = new SurveyCreatorModel({
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

    // The collaboration bar renders itself inside the creator root (above the
    // tabs); participants flow in via the PresencePlugin. Host-specific bits —
    // the lobby invite link and navigation — are plugin options.
    const bar = new CollabBarPlugin(creator, {
        roomId,
        framework: "Vue 3",
        getInviteLink: () => `${location.origin}/?room=${encodeURIComponent(roomId)}`,
        onBack: () => { location.href = "/"; }
    });
    creator.addPlugin("collabBar", bar);

    connectCollab({
        creator, plugin, presence, roomId,
        name: getDisplayName(),
        onStatus: (s) => bar.setStatus(s),
        onHistoryChanged: (changes) => bar.setHistory(changes)
    });

    createApp({ render: () => h(SurveyCreatorComponent, { model: creator }) }).mount("#root");
}
