import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { ACTION_INPUT_CONTRACT } from "../src/action-contract.js";
import {
  AGENTARTS_UPSTREAM_INPUTS,
  RUNTIME_MANAGED_INPUTS,
  loadAgentArtsInputs,
} from "../src/agentarts/inputs.js";
const read = (values: Record<string, string>) => (name: string) =>
  values[name] ?? (name === "github-token" ? "controller-token-fixture" : "");
describe("cloud entrypoint upstream parity", () => {
  it("retains every original public input except supervisor-selected provider and execution settings", async () => {
    const action = z
      .object({ inputs: z.record(z.string(), z.unknown()) })
      .parse(parse(await readFile("agentarts/action.yml", "utf8")));
    expect(AGENTARTS_UPSTREAM_INPUTS.map(({ name }) => name)).toEqual(
      ACTION_INPUT_CONTRACT.filter(({ name }) => !RUNTIME_MANAGED_INPUTS.has(name)).map(
        ({ name }) => name,
      ),
    );
    for (const { name } of AGENTARTS_UPSTREAM_INPUTS)
      expect(action.inputs[name], name).toBeDefined();
    for (const name of RUNTIME_MANAGED_INPUTS) expect(action.inputs[name], name).toBeUndefined();
  });
  it("parses writes, validation, routing, native composition and sessions through the original parser", () => {
    const inputs = loadAgentArtsInputs(
      read({
        command: "task",
        prompt: "Maintain the bound fixture repository",
        "task-access": "write",
        "allow-write": "true",
        "dsh-mode": "native",
        "run-tests": "true",
        "test-commands": '[["node","--test"]]',
        "validation-integrity": "strict",
        "session-mode": "save",
        "session-key": "fixture",
        "trigger-phrase": "@cloud",
        "branch-prefix": "agentarts/",
      }),
    );
    expect(inputs).toMatchObject({
      command: "task",
      taskAccess: "write",
      allowWrite: true,
      dshMode: "native",
      isolation: "docker",
      runTests: true,
      testCommands: [["node", "--test"]],
      validationIntegrity: "strict",
      sessionMode: "save",
      sessionKey: "fixture",
      triggerPhrase: "@cloud",
      branchPrefix: "agentarts/",
    });
  });
  it("does not accept controller-side provider credentials or unsafe executable overrides", () => {
    for (const name of RUNTIME_MANAGED_INPUTS)
      expect(() => loadAgentArtsInputs(read({ [name]: "override" }))).toThrow("Runtime supervisor");
    expect(loadAgentArtsInputs(read({})).allowWrite).toBe(false);
  });
});
