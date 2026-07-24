/// <reference types="vite/client" />
import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { CollabBarPlugin, JournalPlugin, PresencePlugin, registerCreatorTheme } from "survey-creator-core";
import SurveyThemes from "survey-core/themes";
import { SurveyCreator } from "survey-creator-js";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../shared/collab-client";

// Baked in at build time from the environment (see envPrefix in vite.config.ts).
if (import.meta.env.SURVEYJS_LICENSE_KEY) slk(import.meta.env.SURVEYJS_LICENSE_KEY);

// Only the light creator theme is registered out of the box; without a dark
// variant of each theme the Light/Dark switch in the creator's theme settings
// stays disabled. registerCreatorTheme expects survey-core themes (themeName +
// colorPalette pairs), not the survey-creator-core/themes bundle.
registerCreatorTheme(SurveyThemes);

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

    // The collaboration bar renders itself inside the creator root (above the
    // tabs); participants flow in via the PresencePlugin. Host-specific bits —
    // the lobby invite link and navigation — are plugin options.
    const bar = new CollabBarPlugin(creator, {
        roomId,
        framework: "Plain JS",
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

    creator.render(document.getElementById("creator")!);
}
