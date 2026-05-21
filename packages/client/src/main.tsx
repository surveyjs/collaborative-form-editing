import React from "react";
import ReactDOM from "react-dom";
import { App } from "./App";

import "survey-core/survey-core.css";
import "survey-creator-core/survey-creator-core.css";

ReactDOM.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
    document.getElementById("root")
);
