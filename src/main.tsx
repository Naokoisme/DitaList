import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div id="main-window-surface">
      <div id="main-window-content"><App /></div>
      <div id="main-window-bar-origin" aria-hidden="true" />
    </div>
  </React.StrictMode>,
);
