import { createRoot } from "react-dom/client";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.css";

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The lobby form is itself a SurveyJS survey, rendered with survey-react-ui. */
const lobby = new Model({
    title: "Collaborative Survey Creator",
    description: "Pick a framework, join a room — or leave the room id empty to start a fresh one.",
    showQuestionNumbers: "off",
    completeText: "Create & join",
    widthMode: "static",
    width: "680px",
    textUpdateMode: "onTyping",
    elements: [
        {
            type: "imagepicker",
            name: "framework",
            title: "Choose your framework",
            isRequired: true,
            defaultValue: "react",
            showLabel: true,
            imageFit: "contain",
            imageWidth: 96,
            imageHeight: 96,
            choices: [
                { value: "react", text: "React", imageLink: "/logos/react.svg" },
                { value: "angular", text: "Angular", imageLink: "/logos/angular.svg" },
                { value: "vue", text: "Vue", imageLink: "/logos/vue.svg" },
                { value: "js", text: "JS", imageLink: "/logos/js.svg" }
            ]
        },
        {
            type: "text",
            name: "name",
            title: "Your name",
            description: "Shown to other participants next to your cursor and selection.",
            placeholder: "e.g. Maria",
            maxLength: 32
        },
        {
            type: "text",
            name: "roomId",
            title: "Room ID",
            description: "A random room with an empty survey will be created.",
            placeholder: "e.g. my-team",
            maxLength: 64,
            validators: [{
                type: "regex",
                regex: "^[A-Za-z0-9_-]{0,64}$",
                text: "Only letters, digits, - and _ (max 64 chars)."
            }]
        },
        {
            type: "comment",
            name: "seed",
            title: "Initial survey JSON",
            description: "The room doesn't exist yet — it will be created with this initial state.",
            rows: 10,
            visible: false
        }
    ]
});
lobby.showCompletedPage = false;

// roomExists: true | false | null (unknown: empty/invalid/being-checked)
let roomExists: boolean | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let checkSeq = 0;

const roomQ = lobby.getQuestionByName("roomId");
const seedQ = lobby.getQuestionByName("seed");

function updateForRoomState(): void {
    const id = ((lobby.getValue("roomId") as string) ?? "").trim();
    if (id === "") {
        roomExists = null;
        roomQ.description = "A random room with an empty survey will be created.";
        seedQ.visible = false;
        lobby.completeText = "Create & join";
        return;
    }
    if (!ROOM_ID_RE.test(id)) {
        roomExists = null;
        roomQ.description = "Only letters, digits, - and _ (max 64 chars).";
        seedQ.visible = false;
        return;
    }
    const seq = ++checkSeq;
    fetch(`/api/rooms/${encodeURIComponent(id)}`)
        .then((r) => (r.status === 200 ? r.json() : null))
        .then((info) => {
            if (seq !== checkSeq) return; // a newer check superseded this one
            if (info && info.exists) {
                roomExists = true;
                const n = info.clientCount as number;
                roomQ.description = `Room exists — ${n} participant${n === 1 ? "" : "s"} online. You will join it.`;
                seedQ.visible = false;
                lobby.completeText = "Join";
            } else {
                roomExists = false;
                roomQ.description = "Room doesn't exist — it will be created with the initial state below.";
                seedQ.visible = true;
                lobby.completeText = "Create & join";
            }
        })
        .catch(() => {
            if (seq !== checkSeq) return;
            roomExists = null;
            roomQ.description = "Can't reach the server.";
        });
}

lobby.onValueChanged.add((_, options) => {
    if (options.name !== "roomId") return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updateForRoomState, 300);
});

// Reject a malformed seed right on the question (only when it participates).
lobby.onValidateQuestion.add((_, options) => {
    if (options.name !== "seed" || !seedQ.visible) return;
    try {
        JSON.parse((options.value as string) || "{}");
    } catch (e) {
        options.error = `Invalid JSON: ${(e as Error).message}`;
    }
});

function randomRoomId(): string {
    let s = "";
    while (s.length < 8) s += Math.random().toString(36).slice(2);
    return s.slice(0, 8);
}

lobby.onComplete.add(async (sender) => {
    const framework = sender.getValue("framework") as string;
    let id = ((sender.getValue("roomId") as string) ?? "").trim();
    let seed: unknown = {};

    if (id === "") {
        id = randomRoomId();
    } else if (roomExists === false) {
        seed = JSON.parse((sender.getValue("seed") as string) || "{}");
    }

    // Presence display name: persist for next time and pass via URL — in dev
    // the lobby and the clients run on different origins, so localStorage
    // alone wouldn't reach them.
    // Slice by code points, not UTF-16 units — a halved surrogate pair here
    // would poison localStorage and the ?name= param for every future visit.
    const name = [...((sender.getValue("name") as string) ?? "").trim()].slice(0, 32).join("");
    if (name) {
        try {
            localStorage.setItem("collab.name", name);
        } catch { /* private mode etc. — the URL param still carries it */ }
    }

    const enter = (): void => {
        const nameParam = name ? `&name=${encodeURIComponent(name)}` : "";
        location.href = `/${framework}/?room=${encodeURIComponent(id)}${nameParam}`;
    };
    if (roomExists === true) {
        enter();
        return;
    }
    try {
        const res = await fetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomId: id, seed })
        });
        // 201 created; 409 = created concurrently — just join it.
        if (res.status === 201 || res.status === 409) {
            enter();
        } else {
            const body = await res.json().catch(() => ({}));
            roomQ.description = `Failed to create room: ${body.error ?? `HTTP ${res.status}`}`;
            sender.clear(false, false); // back to the form, keep answers
        }
    } catch (e) {
        roomQ.description = `Failed to create room: ${(e as Error).message}`;
        sender.clear(false, false);
    }
});

// Invite links point here with ?room=<id> — prefill and check it right away.
const presetRoom = new URLSearchParams(location.search).get("room");
if (presetRoom) lobby.setValue("roomId", presetRoom);
try {
    const savedName = localStorage.getItem("collab.name");
    if (savedName) lobby.setValue("name", savedName);
} catch { /* private mode — leave the field empty */ }
updateForRoomState();

// Browser Back from a client restores this page from the back-forward cache
// with the survey still in the "completed" state (which renders nothing, as
// showCompletedPage is off). Put the form back, keeping the entered answers,
// and refresh the room info — it may have changed while we were away.
window.addEventListener("pageshow", (ev) => {
    if (ev.persisted && lobby.state === "completed") {
        lobby.clear(false, true);
        updateForRoomState();
    }
});

createRoot(document.getElementById("root")!).render(<Survey model={lobby} />);
