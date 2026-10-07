import { runLiveFullMain } from "./live-full.js";

void runLiveFullMain().catch(() => {
  process.stderr.write(
    "Full verification refused or failed. No automatic retry or GitHub publication; inspect bounded evidence when present.\n",
  );
  process.exitCode = 1;
});
