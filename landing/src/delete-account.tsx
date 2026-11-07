import React from "react";
import ReactDOM from "react-dom/client";
import { DeleteAccount } from "./pages/deleteAccount";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DeleteAccount />
  </React.StrictMode>,
);
