import * as monaco from "monaco-editor/editor/editor.api.js";
// The JSON mode loads the editor features lazily; registered after the first editor, they break every later one.
import "monaco-editor/features/register.all.js";
import "monaco-editor/language/json/monaco.contribution.js";
import type { IMonacoWorkers } from "../../../../shared/monaco-json-editor";

export { monaco };

export const monacoWorkers: IMonacoWorkers = {
    createEditorWorker: () => new Worker(new URL("./editor.worker", import.meta.url), { type: "module" }),
    createJsonWorker: () => new Worker(new URL("./json.worker", import.meta.url), { type: "module" })
};
