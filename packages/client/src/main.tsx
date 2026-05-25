import React from "react";
import ReactDOM from "react-dom";
import { App } from "./App";

import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";

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
