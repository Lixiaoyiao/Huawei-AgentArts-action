import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

// Explicit post-build loading probe. No model, cloud, Docker or GitHub operation
// is attempted: each executable intentionally receives missing configuration.
const root = resolve(import.meta.dirname, "..");
const entries = ["controller", "runtime", "local-proof", "live-review", "live-full"];
const temporary = await mkdtemp(join(tmpdir(), "agentarts-bundle-start-"));
const checks = [];
try {
  const fixtures = join(temporary, "agentarts/fixtures/pr-review");
  await mkdir(fixtures, { recursive: true });
  await cp(join(root, "agentarts/fixtures/pr-review/cases.json"), join(fixtures, "cases.json"));
  for (const entry of entries) {
    const source = join(root, "dist-agentarts", entry),
      destination = join(temporary, "dist-agentarts", entry);
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    await assert.rejects(stat(join(temporary, "node_modules")), { code: "ENOENT" });
    await assert.rejects(stat(join(temporary, "package.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(temporary, "dist-agentarts/package.json")), { code: "ENOENT" });
    const env = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    // --out without a value stops local-proof before it starts its local SSE
    // fixture. The other executables refuse absent config or an unknown flag.
    const args = entry === "local-proof" ? ["--out"] : ["--bundle-load-probe"];
    const result = spawnSync(process.execPath, [join(destination, "index.js"), ...args], {
      cwd: destination,
      env,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    assert(
      !/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ReferenceError|SyntaxError/u.test(
        output,
      ),
      `${entry} failed to load its isolated bundle`,
    );
    assert.notEqual(result.status, null, `${entry} did not stop after configuration refusal`);
    assert.notEqual(result.status, 0, `${entry} unexpectedly executed with missing configuration`);
    const metadata = JSON.parse(
      await readFile(join(destination, "bundle-adaptations.json"), "utf8"),
    );
    assert.equal(metadata.adaptations[0].version, "0.2.0-rc.2");
    checks.push({
      bundle: entry,
      status: "passed",
      exitCode: result.status,
      scope: "module-load-and-expected-configuration-refusal",
      hostNodeModulesAvailable: false,
      adaptation: metadata.adaptations[0],
    });
    if (entry === "live-full" || entry === "live-review") {
      for (const count of entry === "live-full" ? [2, 7] : [4]) {
        const planned = spawnSync(
          process.execPath,
          [
            join(destination, "index.js"),
            "--dry-run",
            "--mode",
            "local-real-model",
            "--max-cases",
            String(count),
            "--out",
            join(temporary, "not-created"),
          ],
          {
            cwd: temporary,
            env,
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
            windowsHide: true,
          },
        );
        if (planned.error) throw planned.error;
        assert.equal(planned.status, 0, `${entry} dry-run must exit successfully`);
        assert.equal(
          planned.stderr,
          "",
          `${entry} dry-run unexpectedly launched or rejected another CLI`,
        );
        const document = JSON.parse(planned.stdout);
        assert.equal(document.status, "dry-run");
        assert.equal(document.plan.cases.length, count);
        assert.equal(document.plan.execute, false);
        await assert.rejects(stat(join(temporary, "not-created")), { code: "ENOENT" });
        checks.push({
          bundle: entry,
          status: "passed",
          scope: "single-cli-dry-run-no-side-effects",
          caseCount: count,
          exitCode: 0,
        });
      }
    }
  }
} finally {
  const safe = resolve(temporary);
  assert(
    safe.startsWith(resolve(tmpdir()) + sep) &&
      basename(safe).startsWith("agentarts-bundle-start-"),
  );
  await rm(safe, { recursive: true, force: true });
}
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, checks, cloudVerification: "not-performed", githubPublication: "not-attempted", modelCalls: 0 }, null, 2)}\n`,
);
