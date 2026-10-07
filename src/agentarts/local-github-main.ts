import { runLocalGitHubReviewMain } from "./local-github-review.js";

void runLocalGitHubReviewMain().catch(() => {
  process.stderr.write(
    "Local GitHub review refused. No automatic replay; inspect private bounded evidence when present.\n",
  );
  process.exitCode = 1;
});
