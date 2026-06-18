import React, { useEffect, useMemo, useRef, useState } from "react";
import { surveyLocalization } from "survey-core";
import { SurveyCreator, SurveyCreatorComponent } from "survey-creator-react";
import { UndoRedoSyncPlugin } from "@collab/creator-undo-redo-sync";
import type { ISyncMessage } from "@collab/shared";
import { CollabClient } from "./collab-client";
import { planTranslationRefresh, applyTranslationRefresh } from "./translation-refresh";

export interface ICollaborativeCreatorProps {
    sessionId: string;
}

type ConnState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Renders a SurveyJS Creator and synchronises every undo/redo transaction
 * with the collaboration server over a WebSocket.
 */
export function CollaborativeCreator(props: ICollaborativeCreatorProps): JSX.Element {
    // The creator survives across renders; props/options that depend on
    // sessionId would be unusual but we still recreate when sessionId changes.
    const creator = useMemo(() => {
        return new SurveyCreator({
            showLogicTab: true,
            showTranslationTab: true,
            showJSONEditorTab: true
        });
    }, [props.sessionId]);

    const clientRef = useRef<CollabClient | null>(null);
    const pluginRef = useRef<UndoRedoSyncPlugin | null>(null);
    // The UndoRedoManager instance the current plugin is bound to. The
    // creator replaces its manager whenever it rebuilds the survey (e.g. on
    // `creator.JSON = ...`), so we recreate the plugin when it changes.
    const boundManagerRef = useRef<unknown>(null);
    const [conn, setConn] = useState<ConnState>("connecting");
    const [peerId, setPeerId] = useState<string | null>(null);

    useEffect(() => {
        const wsUrl = buildWsUrl(props.sessionId);

        // (Re)bind the UndoRedoSyncPlugin to the creator's *current*
        // UndoRedoManager. Outbound wire messages are forwarded to the
        // server; inbound messages are fed back via `plugin.applySerialized`.
        const ensureSyncPlugin = (): UndoRedoSyncPlugin | null => {
            const manager = creator.undoRedoManager;
            if (!manager) return pluginRef.current;
            if (pluginRef.current && boundManagerRef.current === manager) {
                return pluginRef.current;
            }
            pluginRef.current?.dispose();
            const plugin = new UndoRedoSyncPlugin(creator);
            plugin.onSerializedChanges = (message: ISyncMessage) => {
                clientRef.current?.sendSync(message);
            };
            pluginRef.current = plugin;
            boundManagerRef.current = manager;
            return plugin;
        };

        // Remote edits mutate `creator.survey` in place. The Designer/Preview
        // tabs are bound to it directly, but the Translations tab keeps its own
        // snapshot model (a TranslationGroup tree + a `stringsSurvey` matrix)
        // that is only rebuilt on activation. So while that tab is active we
        // refresh it ourselves with the cheapest correct action (see
        // `planTranslationRefresh` / `applyTranslationRefresh`): a structural
        // change rebuilds; otherwise we re-read the snapshot data and register
        // any not-yet-listed locale as an unchecked row (table columns unchanged).
        const refreshTranslationTab = (message: ISyncMessage): void => {
            if (creator.activeTab !== "translation") return;
            const model = (creator.getPlugin("translation", false) as any)?.model;
            if (!model) return;
            const plan = planTranslationRefresh(message, {
                visible: new Set<string>(model.getVisibleLocales?.() ?? []),
                localeCodes: new Set<string>(surveyLocalization.getLocales())
            });
            applyTranslationRefresh(model, plan);
        };

        const client = new CollabClient(wsUrl, {
            onOpen: () => setConn("connected"),
            onClose: () => setConn("disconnected"),
            onError: () => setConn("error"),
            onInit: (schema, clientId, stack) => {
                setPeerId(clientId);
                // Replace the schema; this rebuilds the survey + manager.
                try {
                    creator.JSON = schema ?? {};
                } catch {
                    creator.JSON = {};
                }
                // Adopt the shared undo/redo stack so a late joiner can
                // undo/redo transactions authored before it connected. The
                // plugin must be (re)bound to the freshly-rebuilt manager
                // first; an empty stack is a harmless no-op.
                const plugin = ensureSyncPlugin();
                if (plugin) {
                    try {
                        plugin.importStack(stack);
                    } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn("importStack failed", err);
                    }
                }
            },
            onRemoteSync: (message) => {
                const plugin = ensureSyncPlugin();
                if (!plugin) return;
                try {
                    plugin.applySerialized(message);
                    refreshTranslationTab(message);
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn("applySerialized failed", err);
                }
            }
        });
        clientRef.current = client;

        return () => {
            client.dispose();
            clientRef.current = null;
            pluginRef.current?.dispose();
            pluginRef.current = null;
            boundManagerRef.current = null;
        };
    }, [creator, props.sessionId]);

    return (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <ConnectionBar
                sessionId={props.sessionId}
                state={conn}
                clientId={peerId}
            />
            <div style={{ flex: 1, position: "relative" }}>
                <SurveyCreatorComponent creator={creator} />
            </div>
        </div>
    );
}

function buildWsUrl(sessionId: string): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}`;
}
function ConnectionBar(props: {
    sessionId: string;
    state: ConnState;
    clientId: string | null;
}): JSX.Element {
    const color =
        props.state === "connected" ? "#1e8a4f" :
            props.state === "connecting" ? "#b78600" :
                "#b00020";
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "6px 12px",
                background: "#f5f5f5",
                borderBottom: "1px solid #e0e0e0",
                fontFamily: "system-ui, sans-serif",
                fontSize: 13
            }}
        >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                    aria-hidden
                    style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: color,
                        display: "inline-block"
                    }}
                />
                <strong>{props.state}</strong>
            </span>
            <span>
                Session:&nbsp;
                <code style={{ background: "#fff", padding: "1px 6px", borderRadius: 3 }}>
                    {props.sessionId}
                </code>
            </span>
            {props.clientId && (
                <span style={{ color: "#666" }}>
                    you: <code>{props.clientId.slice(0, 8)}</code>
                </span>
            )}
            <span style={{ marginLeft: "auto" }}>
                <button
                    type="button"
                    onClick={() => {
                        void navigator.clipboard.writeText(window.location.href);
                    }}
                >
                    Copy invite link
                </button>
            </span>
        </div>
    );
}
