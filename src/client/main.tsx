import React from "react";
import ReactDOM from "react-dom";
import { slk } from "survey-core";
import { App } from "./App";

import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";

// Activate the SurveyJS commercial license. Must run before any SurveyModel
// or SurveyCreator is instantiated.
slk("ZG9tYWluczpzdXJ2ZXlqcy5pbyxzdXJ2ZXlqc25leHQsbG9jYWxob3N0OzE9MjAzNi0wMy0yNywyPTIwMzYtMDMtMjcsND0yMDM2LTAzLTI3LDg9MjAzNi0wMy0yNw==");

// Localization dictionaries for survey-core and survey-creator-core.
// Importing these registers all bundled locales (ru, de, fr, etc.) with
// the SurveyJS localization system. Without them only English strings are
// available and `surveyLocalization.supportedLocales` is effectively empty.
import "survey-core/i18n";
import "survey-creator-core/i18n";

ReactDOM.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
    document.getElementById("root")
);
