import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function assertVerifiedRun(run, { repository, sha, workflowId }) {
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("Release candidate verification has not succeeded");
  if (run.event !== "workflow_dispatch" || run.workflow_id !== workflowId || run.path !== ".github/workflows/verify.yml") throw new Error("Expected a manual Release candidate workflow run");
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error("Verification must belong to this repository");
  if (run.head_sha !== sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Selected commit differs from the verified commit; verify this commit first");
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Invalid verification attempt");
  return `release-${sha}-${run.run_attempt}`;
}

export async function main(env = process.env) {
  const id = env.VERIFICATION_RUN_ID;
  if (!/^[1-9][0-9]*$/.test(id || "")) throw new Error("verification_run_id must be a numeric GitHub Actions run ID");
  const base = `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/actions`;
  async function get(suffix) {
    const response = await fetch(`${base}/${suffix}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Cannot verify release candidate: GitHub API returned ${response.status}`);
    return response.json();
  }
  const [run, workflow] = await Promise.all([get(`runs/${id}`), get("workflows/verify.yml")]);
  const artifact = assertVerifiedRun(run, { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, workflowId: workflow.id });
  await appendFile(env.GITHUB_OUTPUT, `artifact=${artifact}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
