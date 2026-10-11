import React from "react";
import { createRoot } from "react-dom/client";
import { Desktop } from "./Desktop";
import { Mobile } from "./Mobile";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.dropbridge ? <Desktop /> : <Mobile />}
  </React.StrictMode>,
);
