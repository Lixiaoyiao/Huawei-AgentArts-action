/* Controller admission for the published DSH Session/Headless lifecycle. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const name = "dsh-action-session";
const PLAN_KEYS = new Set([
  "schemaVersion",
  "bindingDigest",
  "permissionMode",
  "workingDirectory",
  "sessionId",
  "checkpointEventCount",
]);
const SESSION_ID = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_PLAN_BYTES = 8 * 1024;

function fail(message) {
  throw new Error(`dsh-action-session: ${message}`);
}

export function validateSessionPlan(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !PLAN_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.bindingDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.bindingDigest) ||
    !["read-only", "workspace-write"].includes(value.permissionMode) ||
    typeof value.workingDirectory !== "string" ||
    !isAbsolute(value.workingDirectory) ||
    [...value.workingDirectory].some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    ) ||
    Buffer.byteLength(value.workingDirectory, "utf8") > 1024 ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" ||
        !SESSION_ID.test(value.sessionId) ||
        !Number.isSafeInteger(value.checkpointEventCount) ||
        value.checkpointEventCount <= 0 ||
        value.checkpointEventCount > 1_000_000)) ||
    (value.sessionId === undefined && value.checkpointEventCount !== undefined)
  ) {
    fail("invalid Controller session plan");
  }
  return Object.freeze({ ...value });
}

/** Read only the Controller-owned fixed file, before composing worker code. */
export function readSessionPlan(path, home) {
  if (!isAbsolute(home) || resolve(path) !== resolve(home, "action-state", "session-plan.json")) {
    fail("session plan must be the fixed Controller action-state file");
  }
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_PLAN_BYTES) {
    fail("session plan must be a bounded regular file");
  }
  if (realpathSync(dirname(path)) !== resolve(home, "action-state")) {
    fail("session plan parent must not be a symbolic link");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_PLAN_BYTES ||
      opened.dev !== details.dev ||
      opened.ino !== details.ino
    ) {
      fail("session plan changed while opening");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_PLAN_BYTES) fail("session plan exceeded its byte limit");
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("session plan must contain strict UTF-8 JSON");
    }
    return validateSessionPlan(value);
  } finally {
    closeSync(descriptor);
  }
}

/** This hook composes policy; the official Headless plugin still drives the Agent. */
export function installSessionAdmission(ctx, rawPlan, { auditPath } = {}) {
  const plan = validateSessionPlan(rawPlan);
  if (
    auditPath !== undefined &&
    (!isAbsolute(auditPath) || !auditPath.endsWith("session-admission.json"))
  ) {
    fail("session admission audit requires its Controller-owned absolute path");
  }
  const ready = new WeakSet();
  let rootId = plan.sessionId;
  let rootSeen = false;
  const services = () => {
    const sandbox = ctx.get("sandboxPolicy");
    const approval = ctx.get("approval");
    const permissions = ctx.get("permissionPresets");
    if (sandbox === undefined || approval === undefined || permissions === undefined) {
      fail("published sandbox, approval and permission services are required");
    }
    const preset = permissions.resolve(plan.permissionMode);
    if (
      sandbox.defaultMode !== plan.permissionMode ||
      preset.sandbox !== plan.permissionMode ||
      preset.approval !== "never"
    ) {
      fail("session plan cannot broaden or replace the current composition policy");
    }
    return { sandbox, approval, permissions };
  };
  const assertCurrent = (agent) => {
    if (agent === undefined || !ready.has(agent)) fail("Agent was not admitted before execution");
    const { sandbox, approval, permissions } = services();
    if (
      agent.session.header.cwd !== plan.workingDirectory ||
      sandbox.resolve({ session: agent.session }).mode !== plan.permissionMode ||
      approval.effectivePolicy(agent.session) !== "never" ||
      permissions.current(agent.session) !== plan.permissionMode
    ) {
      fail("current Session policy drifted after Controller admission");
    }
  };
  ctx.on(
    "agent/created",
    ({ agent, source }) => {
      const session = agent.session;
      const child =
        session.header.origin === "subagent" || session.header.parentSession !== undefined;
      if (session.header.cwd !== plan.workingDirectory)
        fail("Session working directory is not bound");
      if (!child) {
        if (rootId !== undefined && session.id !== rootId) fail("Session identity is not bound");
        if (!rootSeen && source !== (plan.sessionId === undefined ? "startup" : "resume")) {
          fail("Session lifecycle source does not match the Controller plan");
        }
        rootId ??= session.id;
        if (
          !rootSeen &&
          plan.sessionId !== undefined &&
          session.firstLiveSeq !== plan.checkpointEventCount
        ) {
          fail("restored Session event count changed; interrupted recovery is not admitted");
        }
        if (agent.inbox.nextTurn.length !== 0 || agent.inbox.nextStep.length !== 0) {
          fail("historical pending input must not be replayed");
        }
      }
      const { permissions } = services();
      const beforeSeq = session.seq;
      // set() is the public canonical knob writer. It replaces historical
      // permission/preset, sandbox/mode and approval/policy as needed; no old
      // authority is inferred, no conversation event is rewritten or replayed.
      permissions.set(session, plan.permissionMode);
      ready.add(agent);
      assertCurrent(agent);
      if (!child) {
        rootSeen = true;
        if (auditPath !== undefined) {
          mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
          const temporary = `${auditPath}.${process.pid}.tmp`;
          writeFileSync(
            temporary,
            `${JSON.stringify({
              schemaVersion: 1,
              bindingDigest: plan.bindingDigest,
              sessionId: session.id,
              source,
              workingDirectory: session.header.cwd,
              permissionMode: plan.permissionMode,
              approvalPolicy: "never",
              permissionPreset: plan.permissionMode,
              beforeSeq,
              afterSeq: session.seq,
            })}\n`,
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
          renameSync(temporary, auditPath);
        }
      }
    },
    { prepend: true },
  );
  ctx.on(
    "agent/request",
    async ({ agent }, next) => {
      assertCurrent(agent);
      const call = await next();
      assertCurrent(agent);
      return call;
    },
    { prepend: true },
  );
  ctx.inject(["tools"], (scope) => {
    scope.tools.guard((execution) => {
      try {
        assertCurrent(execution.agent);
      } catch {
        return "dsh-action-session: current Controller Session admission is required";
      }
      return undefined;
    });
  });
}

/** Ordinary Cordis plugin entry, also usable from both existing launchers. */
export function apply(ctx, config) {
  const home = process.env.DSH_HOME;
  if (typeof home !== "string" || !isAbsolute(home)) fail("DSH_HOME is required");
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => key !== "planPath") ||
    typeof config.planPath !== "string"
  ) {
    fail("plugin requires only a Controller session plan path");
  }
  installSessionAdmission(ctx, readSessionPlan(config.planPath, home), {
    auditPath: join(home, "action-state", "session-admission.json"),
  });
}
