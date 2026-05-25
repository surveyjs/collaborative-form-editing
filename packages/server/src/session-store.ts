import { randomUUID } from "node:crypto";
import { SurveyModel } from "survey-core";
import { UndoRedoManager } from "survey-creator-core";
import type { ISyncMessage } from "@collab/shared";

export interface ISession {
    id: string;
    surveyModel: SurveyModel;
    /** A manager bound to `surveyModel`, reused for every incoming message. */
    undoRedoManager: UndoRedoManager;
    /** Connected client IDs are kept by the WS layer; we expose only the count. */
    clientCount: number;
}

const sessions = new Map<string, ISession>();

function makeSession(id: string, surveyModel: SurveyModel): ISession {
    const undoRedoManager = new UndoRedoManager();
    undoRedoManager.survey = surveyModel;
    return { id, surveyModel, undoRedoManager, clientCount: 0 };
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

/** Apply every action in the message to the session's authoritative model. */
export function applyMessage(session: ISession, message: ISyncMessage): void {
    if (!message || message.kind !== "transaction" || !Array.isArray(message.actions)) return;
    try {
        // The manager already detaches the survey's change observer and
        // sets `_ignoreChanges` while applying, so this won't enter any
        // local undo stack or fire callbacks.
        session.undoRedoManager.applySerialized(message as any);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[session ${session.id}] failed to apply message`, err);
    }
}

export function snapshot(session: ISession): any {
    return session.surveyModel.toJSON();
}
