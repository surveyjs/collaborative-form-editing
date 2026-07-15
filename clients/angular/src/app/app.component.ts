import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from "@angular/core";
// Localization dictionaries: importing registers all bundled locales (ru, de,
// fr, ...) — without them the Translation tab has no languages to add.
import "survey-core/i18n";
import "survey-creator-core/i18n";
import { slk } from "survey-core";
import { JournalPlugin, SurveyCreatorModel, buildLocator, resolveLocator } from "survey-creator-core";
import { SurveyCreatorModule } from "survey-creator-angular";
import { connectCollab, getDisplayName, getRoomIdFromUrl } from "../../../../shared/collab-client";
import type { ICollabConnection } from "../../../../shared/collab-client";
import { initPresenceCapture } from "../../../../shared/presence-capture";
import { initPresenceOverlay } from "../../../../shared/presence-overlay";
import type { IPresenceOverlay } from "../../../../shared/presence-overlay";
import { initStatusBar } from "../../../../shared/status-bar";
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
    private readonly roomId: string | null;
    private connection?: ICollabConnection;
    private capture?: { dispose(): void };
    private overlay?: IPresenceOverlay;

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
    }

    ngAfterViewInit(): void {
        if (!this.roomId) return;
        const bar = initStatusBar(this.barElement.nativeElement, "Angular", this.roomId);

        // Locator functions come from THIS app's survey-creator-core copy — the
        // shared presence modules must not import the library themselves.
        const locator = {
            build: (obj: unknown, survey: unknown): string => buildLocator(obj, survey as never),
            resolve: (loc: string, survey: unknown): unknown => resolveLocator(loc, survey as never)
        };

        this.connection = connectCollab({
            creator: this.creator,
            plugin: this.plugin,
            roomId: this.roomId,
            name: getDisplayName(),
            onStatus: (s) => bar.setStatus(s),
            onPresence: (peers) => {
                this.overlay?.refresh();
                bar.setParticipants([...peers.values()].map((p) => ({
                    id: p.clientId, name: p.state.name, color: p.color, tab: p.state.tab
                })));
            }
        });
        const collab = this.connection;
        this.capture = initPresenceCapture({
            creator: this.creator,
            locator,
            send: (partial) => collab.updatePresence(partial)
        });
        this.overlay = initPresenceOverlay({
            creator: this.creator,
            locator,
            getPeers: () => collab.getPeers()
        });
    }

    ngOnDestroy(): void {
        this.capture?.dispose();
        this.overlay?.dispose();
        this.connection?.dispose();
    }
}
