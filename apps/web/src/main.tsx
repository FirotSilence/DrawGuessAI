import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./i18n";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Root element is missing");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
