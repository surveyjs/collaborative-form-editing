/**
 * Turns on Survey Creator's Monaco JSON tab. The Creator picks Monaco when
 * `window.monaco` is set before it is constructed. Like the other shared
 * modules, this one has no runtime imports: each client imports
 * `monaco-editor` from its own dependencies and creates the workers with its
 * own bundler, then passes both here.
 */

export interface IMonacoLike {
    editor: { setTheme(themeName: string): void };
}

export interface IMonacoWorkers {
    createEditorWorker(): Worker;
    createJsonWorker(): Worker;
}

interface ICreatorEvent {
    add(handler: () => void): void;
}

export interface ICreatorPaletteLike {
    preferredColorPalette: string;
    onCreatorThemeSelected: ICreatorEvent;
    onCreatorThemePropertyChanged: ICreatorEvent;
}

interface IMonacoHost {
    monaco?: IMonacoLike;
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
}

export function installMonaco(monaco: IMonacoLike, workers: IMonacoWorkers): void {
    const host = window as unknown as IMonacoHost;
    host.MonacoEnvironment = {
        getWorker: (_workerId, label) => (label === "json" ? workers.createJsonWorker() : workers.createEditorWorker())
    };
    host.monaco = monaco;
}

export function followCreatorColorPalette(monaco: IMonacoLike, creator: ICreatorPaletteLike): void {
    const applyTheme = () => monaco.editor.setTheme(creator.preferredColorPalette === "dark" ? "vs-dark" : "vs");
    applyTheme();
    creator.onCreatorThemeSelected.add(applyTheme);
    creator.onCreatorThemePropertyChanged.add(applyTheme);
}
