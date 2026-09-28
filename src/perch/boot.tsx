import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createMockSource, MockPanel } from "./mock";
import "./perch.css";
import { realSource } from "./source";
import { getIdentifier } from "@tauri-apps/api/app";

// The verification build (bun run build:verify) changes the background color so it can be told apart from the everyday build at a glance
getIdentifier()
  .then((id) => {
    if (id.endsWith(".verify")) document.documentElement.dataset.build = "verify";
  })
  .catch(() => {}); // do nothing outside Tauri, e.g. static serving with ?mock=1

const params = new URLSearchParams(location.search);
const isMock = params.has("mock");

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (isMock) {
  // Create just one mock source instance and pass it to both App and the panel. App.tsx
  // reflects panel edits immediately through source.subscribe, so both must refer to the same
  // instance (creating one each in App and MockPanel would give them separate data)
  const source = createMockSource();
  root.render(
    <React.StrictMode>
      <App source={source} extraPanel={<MockPanel source={source} />} />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <App source={realSource} />
    </React.StrictMode>,
  );
}
