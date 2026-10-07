import { runLiveReviewMain } from "./live-review.js";

void runLiveReviewMain().catch(() => {
  process.stderr.write(
    "Verification refused or failed. No automatic retry or GitHub publication; inspect the bounded evidence when present.\n",
  );
  process.exitCode = 1;
});
