import React, { useEffect, useState } from "react";
import type {
    ICreateSessionRequest,
    ICreateSessionResponse
} from "@collab/shared";
import { CollaborativeCreator } from "./CollaborativeCreator";

const SAMPLE_SCHEMA = {
    title: "New collaborative survey2",
    pages: [
        {
            name: "page1",
            elements: [
                { type: "text", name: "question1", title: "Your first question" }
            ]
        }
    ]
};

function getSessionFromUrl(): string | null {
    const segment = window.location.pathname.replace(/^\/+|\/+$/g, "");
    return segment.length > 0 ? decodeURIComponent(segment) : null;
}

function setSessionInUrl(id: string): void {
    const url = new URL(window.location.href);
    url.pathname = `/${encodeURIComponent(id)}`;
    window.history.replaceState({}, "", url);
}

export function App(): JSX.Element {
    const [sessionId, setSessionId] = useState<string | null>(getSessionFromUrl);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const onPop = () => setSessionId(getSessionFromUrl());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    useEffect(() => {
        if (sessionId) return;
        let cancelled = false;
        (async () => {
            try {
                const body: ICreateSessionRequest = { schema: SAMPLE_SCHEMA };
                const res = await fetch("/api/sessions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as ICreateSessionResponse;
                if (cancelled) return;
                setSessionInUrl(data.sessionId);
                setSessionId(data.sessionId);
            } catch (e) {
                if (!cancelled) setError((e as Error).message);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);

    if (sessionId) {
        return <CollaborativeCreator key={sessionId} sessionId={sessionId} />;
    }
    return <Splash error={error} />;
}

function Splash(props: { error: string | null }): JSX.Element {
    return (
        <div
            style={{
                maxWidth: 480,
                margin: "10vh auto",
                padding: 24,
                fontFamily: "system-ui, sans-serif",
                textAlign: "center"
            }}
        >
            {props.error ? (
                <p role="alert" style={{ color: "#b00020" }}>
                    Failed to create session: {props.error}
                </p>
            ) : (
                <p style={{ color: "#666" }}>Creating session…</p>
            )}
        </div>
    );
}
