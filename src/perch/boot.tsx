import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createMockSource, MockPanel } from "./mock";
import "./perch.css";
import { realSource } from "./source";
import { getIdentifier } from "@tauri-apps/api/app";

// 検証用ビルド(bun run build:verify)は背景色を変え、普段使いの版とひと目で見分ける
getIdentifier()
  .then((id) => {
    if (id.endsWith(".verify")) document.documentElement.dataset.build = "verify";
  })
  .catch(() => {}); // ?mock=1 の静的配信など Tauri の外では何もしない

const params = new URLSearchParams(location.search);
const isMock = params.has("mock");

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (isMock) {
  // mock ソースを1インスタンスだけ作り、App とパネルの両方に渡す。App.tsx が
  // source.subscribe 経由でパネルの編集を即時反映するため、双方が同じインスタンスを
  // 参照している必要がある(App と MockPanel それぞれで作ると別データになってしまう)
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
