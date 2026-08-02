import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

// CRXJS rewrites manifest content scripts to hashed asset filenames, which
// chrome.scripting.registerContentScripts cannot reference, and neither can the
// page-world <script src> the Netflix bridge needs. These files are plain
// vanilla JS with no imports, so copy them verbatim to a stable path.
const DYNAMIC_CONTENT_SCRIPTS = ["chat-overlay.js", "generic.js", "netflix-player-bridge.js"];

function copyDynamicContentScripts() {
  const copyAll = (outDir) => {
    mkdirSync(outDir, { recursive: true });
    DYNAMIC_CONTENT_SCRIPTS.forEach((file) => {
      copyFileSync(resolve(__dirname, "src/content", file), resolve(outDir, file));
    });
  };

  return {
    name: "watchparty-copy-dynamic-content-scripts",
    apply: "build",
    // CRXJS resolves web_accessible_resources before closeBundle, so stage a copy
    // under public/ for the Netflix page-world bridge.
    buildStart() {
      copyAll(resolve(__dirname, "public/dynamic"));
    },
    closeBundle() {
      copyAll(resolve(__dirname, "dist/dynamic"));
    },
  };
}

export default defineConfig({
  plugins: [react(), crx({ manifest }), copyDynamicContentScripts()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "index.html"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
      },
    },
  },
});
