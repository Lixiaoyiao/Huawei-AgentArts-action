/** Preserve normal Actions labels while accurately describing an approved local Controller. */
export function executionContextLinkLabel(url: string): string {
  return /\/actions\/runs\/[^/?#]+(?:[?#].*)?$/u.test(url) ? "Workflow run" : "Execution context";
}
