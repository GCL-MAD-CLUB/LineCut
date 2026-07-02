import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { disableBrowserBehaviors } from "./disable-browser-behaviors";
import "./styles.css";

disableBrowserBehaviors();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
