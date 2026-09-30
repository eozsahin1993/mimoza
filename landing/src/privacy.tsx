import React from "react";
import ReactDOM from "react-dom/client";
import { PrivacyPolicy } from "./pages/privacyPolicy";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivacyPolicy />
  </React.StrictMode>,
);
