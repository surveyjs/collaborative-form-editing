import { randomUUID } from "node:crypto";
import { SurveyModel } from "survey-core";
import { UndoRedoManager } from "survey-creator-core";
import { UndoRedoSyncPlugin } from "@collab/creator-undo-redo-sync";
import type { ISessionSnapshot, ISyncMessage } from "@collab/shared";

export interface ISession {
    id: string;
    surveyModel: SurveyModel;
    /**
     * Sync plugin bound to `surveyModel`, reused for every incoming message.
     * It owns the authoritative transaction stack so undo/redo from any peer
     * is reflected in the server snapshot.
     */
    syncPlugin: UndoRedoSyncPlugin;
    /** Connected client IDs are kept by the WS layer; we expose only the count. */
    clientCount: number;
}

const sessions = new Map<string, ISession>();

function makeSession(id: string, surveyModel: SurveyModel): ISession {
    const undoRedoManager = new UndoRedoManager();
    // The plugin only ever touches `creator.undoRedoManager` and
    // `creator.survey`, so a minimal duck-typed creator is all the headless
    // server needs — no full SurveyCreatorModel required.
    const pseudoCreator = { undoRedoManager, survey: surveyModel } as any;
    const syncPlugin = new UndoRedoSyncPlugin(pseudoCreator);
    return { id, surveyModel, syncPlugin, clientCount: 0 };
}

export function createSession(initialSchema?: any, id?: string): ISession {
    const sessionId = id ?? randomUUID();
    const surveyModel = new SurveyModel(initialSchema ?? {});
    const session = makeSession(sessionId, surveyModel);
    sessions.set(sessionId, session);
    return session;
}

/** Return an existing session by id, or create an empty one if none exists. */
export function getOrCreateSession(id: string): ISession {
    const existing = sessions.get(id);
    if (existing) return existing;
    return createSession(undefined, id);
}

export function getSession(id: string): ISession | undefined {
    return sessions.get(id);
}

export function deleteSession(id: string): void {
    sessions.delete(id);
}

/**
 * Apply a peer message (transaction / undo / redo) to the session's
 * authoritative model, keeping the server snapshot in sync with the shared
 * undo/redo stack.
 */
export function applyMessage(session: ISession, message: ISyncMessage): void {
    if (!message) return;
    try {
        // applySerialized suspends the manager and detaches the survey's
        // change observer while applying, so this won't fire callbacks or
        // re-enter any stack other than the synthetic shared one.
        session.syncPlugin.applySerialized(message);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[session ${session.id}] failed to apply message`, err);
    }
}

/**
 * Full bootstrap state for a joining client: the current survey schema plus
 * the shared undo/redo stack. The stack is exported from the session's
 * authoritative `syncPlugin`, so a late joiner inherits the entire history
 * and can undo/redo transactions authored by any peer before it connected.
 */
export function snapshot(session: ISession): ISessionSnapshot {
    return {
        schema: session.surveyModel.toJSON(),
        stack: session.syncPlugin.exportStack()
    };
}
