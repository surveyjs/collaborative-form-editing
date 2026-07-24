import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from "@angular/core";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { JournalPlugin, PresencePlugin, SurveyCreatorModel } from "survey-creator-core";
import { SurveyCreatorModule } from "survey-creator-angular";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../../shared/collab-client";
import type { ICollabConnection } from "../../../../shared/collab-client";
import { initStatusBar, peersToParticipants } from "../../../../shared/status-bar";
import { SURVEYJS_LICENSE_KEY } from "../license-key";

// Baked in at build time from the environment (see scripts/gen-license-key.mjs).
if (SURVEYJS_LICENSE_KEY) slk(SURVEYJS_LICENSE_KEY);

@Component({
    selector: "app-root",
    standalone: true,
    imports: [SurveyCreatorModule],
    template: `
        <div #bar></div>
        <div style="flex: 1; position: relative">
            <survey-creator [model]="creator"></survey-creator>
        </div>
    `
})
export class AppComponent implements AfterViewInit, OnDestroy {
    @ViewChild("bar") barElement!: ElementRef<HTMLDivElement>;

    public readonly creator: SurveyCreatorModel;
    private readonly plugin: JournalPlugin;
    private readonly presence: PresencePlugin;
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
    }

    ngAfterViewInit(): void {
        if (!this.roomId) return;
        const bar = initStatusBar(this.barElement.nativeElement, "Angular", this.roomId, {
            onSaveVersion: (label) => this.plugin.snapshot(label),
            onGoToParticipant: (user) => { if (user.tab) this.creator.activeTab = user.tab; }
        });

        this.connection = connectCollab({
            creator: this.creator,
            plugin: this.plugin,
            presence: this.presence,
            roomId: this.roomId,
            name: getDisplayName(),
            onStatus: (s) => bar.setStatus(s),
            onPresence: (peers) => bar.setParticipants(peersToParticipants(peers)),
            onHistoryChanged: (changes) => bar.setHistory(changes)
        });
    }

    ngOnDestroy(): void {
        this.presence.dispose();
        this.connection?.dispose();
    }
}
