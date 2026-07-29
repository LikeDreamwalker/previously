import { Octokit } from "octokit";

let octokitInstance: Octokit | null = null;

/**
 * Get the singleton GitHub client instance.
 * Requires GITHUB_TOKEN environment variable.
 * Throws if token is not configured.
 */
export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is not set");
    }
    octokitInstance = new Octokit({
      auth: token,
      request: {
        timeout: 30_000, // 30s per-request cap — prevents hanging API calls
      },
    });
  }
  return octokitInstance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetOctokit(): void {
  octokitInstance = null;
}
