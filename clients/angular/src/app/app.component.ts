import { AfterViewInit, Component, OnDestroy } from "@angular/core";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { CollabBarPlugin, JournalPlugin, PresencePlugin, SurveyCreatorModel } from "survey-creator-core";
import { SurveyCreatorModule } from "survey-creator-angular";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../../shared/collab-client";
import type { ICollabConnection } from "../../../../shared/collab-client";
import { SURVEYJS_LICENSE_KEY } from "../license-key";

// Baked in at build time from the environment (see scripts/gen-license-key.mjs).
if (SURVEYJS_LICENSE_KEY) slk(SURVEYJS_LICENSE_KEY);

@Component({
    selector: "app-root",
    standalone: true,
    imports: [SurveyCreatorModule],
    template: `
        <div style="flex: 1; position: relative">
            <survey-creator [model]="creator"></survey-creator>
        </div>
    `
})
export class AppComponent implements AfterViewInit, OnDestroy {
    public readonly creator: SurveyCreatorModel;
    private readonly plugin: JournalPlugin;
    private readonly presence: PresencePlugin;
    private readonly bar: CollabBarPlugin;
    private readonly roomId: string | null;
    private connection?: ICollabConnection;

    constructor() {
        this.roomId = getRoomIdFromUrl();
        if (!this.roomId) location.href = "/";

        this.creator = new SurveyCreatorModel({
            showLogicTab: true,
            showTranslationTab: true,
            showJSONEditorTab: true
        });
        this.plugin = new JournalPlugin(this.creator);
        this.creator.addPlugin("journal", this.plugin);
        // Captures focus/selection/cursor and renders remote peers; the transport
        // only ships its opaque state (the server stamps name/color on it).
        this.presence = new PresencePlugin(this.creator);
        this.creator.addPlugin("presence", this.presence);
        // The collaboration bar renders itself inside the creator root (above
        // the tabs); participants flow in via the PresencePlugin. Host-specific
        // bits — the lobby invite link and navigation — are plugin options.
        const roomId = this.roomId ?? "";
        this.bar = new CollabBarPlugin(this.creator, {
            roomId,
            framework: "Angular",
            getInviteLink: () => `${location.origin}/?room=${encodeURIComponent(roomId)}`,
            onBack: () => { location.href = "/"; }
        });
        this.creator.addPlugin("collabBar", this.bar);
    }

    ngAfterViewInit(): void {
        if (!this.roomId) return;
        this.connection = connectCollab({
            creator: this.creator,
            plugin: this.plugin,
            presence: this.presence,
            roomId: this.roomId,
            name: getDisplayName(),
            onStatus: (s) => this.bar.setStatus(s),
            onHistoryChanged: (changes) => this.bar.setHistory(changes)
        });
    }

    ngOnDestroy(): void {
        this.bar.dispose();
        this.presence.dispose();
        this.connection?.dispose();
    }
}
