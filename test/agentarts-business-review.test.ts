import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runValidationCommandsInDocker } from "../src/write/validate.js";
import { runCommand } from "../src/security/argv.js";

const enabled =
  process.platform === "linux" && process.env.AGENTARTS_RUN_BUSINESS_REVIEW === "true";
// Trusted audit-only overrides select immutable evidence, never product inputs or task code.
const runId = enabled
  ? (process.env.AGENTARTS_BUSINESS_REVIEW_RUN_ID ?? "c00d93fd-9cd4-4f48-83db-dd2fda770454")
  : "c00d93fd-9cd4-4f48-83db-dd2fda770454";
const evidence =
  (enabled ? process.env.AGENTARTS_BUSINESS_REVIEW_EVIDENCE : undefined) ??
  join(process.cwd(), "agentarts/evidence/full-v3/live-model");
if (
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(runId) ||
  !isAbsolute(evidence)
)
  throw new Error("Independent audit evidence must use an absolute directory and exact run UUID");
const image =
  "docker.io/library/node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d";
const cases = ["fix-bounds", "task-write-roles", "implement-roles", "native-write-bounds"] as const;
const results: unknown[] = [];
interface Candidate {
  runId: string;
  caseId: string;
  taskDigest: string;
  original: { path: string; content: string; sha256: string };
  candidate: { path: string; content: string; sha256: string };
  delta: { inputDigest: string; resultDigest: string };
}
async function packet(caseId: string) {
  const candidateBytes = await readFile(join(evidence, `${runId}.${caseId}.candidate.json`));
  const candidate = JSON.parse(candidateBytes.toString("utf8")) as Candidate;
  const evaluation = JSON.parse(
    await readFile(join(evidence, `${runId}.${caseId}.evaluation.json`), "utf8"),
  ) as {
    taskDigest: string;
    manualVerdict: string;
    delta: Candidate["delta"];
  };
  expect(candidate.runId).toBe(runId);
  expect(candidate.caseId).toBe(caseId);
  expect(candidate.taskDigest).toBe(evaluation.taskDigest);
  expect(candidate.delta).toMatchObject({
    inputDigest: evaluation.delta.inputDigest,
    resultDigest: evaluation.delta.resultDigest,
  });
  expect(evaluation.manualVerdict).toBe("not-reviewed");
  for (const file of [candidate.original, candidate.candidate])
    expect(createHash("sha256").update(file.content).digest("hex")).toBe(file.sha256);
  expect(candidate.original.path).toBe(candidate.candidate.path);
  expect(["src/bounds.ts", "src/access.ts"]).toContain(candidate.candidate.path);
  return { candidate, artifactSha256: createHash("sha256").update(candidateBytes).digest("hex") };
}

/** Independent oracle: interval membership/set difference, plus frozen inputs; candidate executes only in Docker. */
function hiddenScript(bounds: boolean): string {
  return `import assert from 'node:assert/strict';
import * as candidate from './candidate.ts';
let contracts=0;
${
  bounds
    ? `
for(let length=0;length<=32;length++){
  const valid=new Set(Array.from({length},(_,i)=>i));
  for(let index=-5;index<=length+5;index++){
    assert.equal(candidate.inBounds(index,length),valid.has(index),'integer interval '+index+'/'+length);contracts++;
  }
}
for(const [index,length,expected] of [[-0,1,true],[-1,0,false],[Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER,true],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,false],[0,Number.MAX_SAFE_INTEGER,true]]){
  assert.equal(candidate.inBounds(index,length),expected,'large safe integer contract');contracts++;
}`
    : `
const universe=['reader','owner','Reader','é','e\u0301'];
const subsets=Array.from({length:2**universe.length},(_,bits)=>universe.filter((_,i)=>(bits&(1<<i))!==0));
for(const user of subsets)for(const required of subsets){
  const available=new Set(user),missing=new Set(required);
  for(const role of available)missing.delete(role);
  const users=Object.freeze([...user]),requirements=Object.freeze([...required]);
  assert.equal(candidate.hasRequiredRoles(users,requirements),missing.size===0,'exact role set difference');contracts++;
}
for(const [user,required,expected] of [[['reader','reader'],['reader','reader'],true],[['OWNER'],['owner'],false],[['💡'],['💡'],true],[['é'],['e\u0301'],false],[[],[],true],[['extra'],[],true]]){
  assert.equal(candidate.hasRequiredRoles(Object.freeze(user),Object.freeze(required)),expected,'duplicates/unicode/empty');contracts++;
}`
}
console.log(JSON.stringify({contracts,passed:true}));
`;
}
afterAll(async () => {
  const destination = process.env.AGENTARTS_BUSINESS_REVIEW_OUT;
  if (!enabled || destination === undefined) return;
  await writeFile(
    destination,
    JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        reviewKind: "ai-independent-review-and-hidden-contracts",
        reviewer: "Codex independent AI reviewer",
        reviewedAt: new Date().toISOString(),
        humanReviewRequired: true,
        manualVerdict: "not-reviewed",
        modelCalled: false,
        cloudCalled: false,
        githubPublished: false,
        network: "none",
        validationImage: image,
        records: results,
        limitations: [
          "AI review is not a human acceptance verdict.",
          "Original model results, source/candidate bytes and manualVerdict were not edited.",
          "Bounds acceptance is restricted to the documented nonnegative integer-length/integer-index domain.",
          "Additional contracts cannot prove arbitrary requirements or code correctness.",
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
});
describe("independent review of retained real-model candidates", () => {
  it("retains exact candidate bytes, hashes and immutable evaluation binding", async () => {
    for (const caseId of cases) await packet(caseId);
  });
  it.skipIf(!enabled).each(cases)(
    "runs hidden business contracts for %s in a no-network independent Docker validator",
    async (caseId) => {
      const checked = await packet(caseId),
        root = await mkdtemp(join(tmpdir(), "agentarts-independent-review-"));
      const started = Date.now();
      try {
        await writeFile(join(root, "package.json"), '{"type":"module"}');
        await writeFile(join(root, "candidate.ts"), checked.candidate.candidate.content);
        await writeFile(join(root, "hidden.mjs"), hiddenScript(caseId.includes("bounds")));
        const validation = await runValidationCommandsInDocker(
          root,
          [["node", "hidden.mjs"]],
          image,
          30_000,
          (options) => {
            const args = [...options.args];
            const index = args.indexOf("--network");
            if (index >= 0) args[index + 1] = "none";
            return runCommand({ ...options, args });
          },
        );
        const result = validation[0]?.result;
        expect(result?.exitCode, result?.stderr).toBe(0);
        expect(result?.timedOut).toBe(false);
        const report = JSON.parse(result?.stdout ?? "null") as {
          contracts: number;
          passed: boolean;
        };
        expect(report.passed).toBe(true);
        expect(report.contracts).toBe(caseId.includes("bounds") ? 896 : 1030);
        results.push({
          caseId,
          status: "passed",
          ...report,
          artifactSha256: checked.artifactSha256,
          candidateSha256: checked.candidate.candidate.sha256,
          durationMs: Date.now() - started,
        });
      } catch (error: unknown) {
        results.push({
          caseId,
          status: "failed",
          failure: error instanceof Error ? error.name : "Error",
          durationMs: Date.now() - started,
        });
        throw error;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
