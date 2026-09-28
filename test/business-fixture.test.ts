import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { parseDshOutput } from "../src/dsh/schema.js";

const moduleUrl = new URL("../.github/e2e/business-fixture.mjs", import.meta.url).href;
const settings = {
  fixturePath: ".github/dsh-e2e-fixtures/checks-10-1.txt",
  implementationPath: "dsh-e2e-implementation-10-1.txt",
  suffix: "10/1",
};

function invoke(route: string, index: number, body: unknown, configuration = settings) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from "node:fs";
    const { businessReply } = await import(process.argv[1]);
    const args = JSON.parse(readFileSync(0,"utf8"));
    try { process.stdout.write(JSON.stringify({value: businessReply(...args)})); }
    catch (error) { process.stdout.write(JSON.stringify({error: error.message})); }
  `,
      moduleUrl,
    ],
    { input: JSON.stringify([route, index, body, configuration]), encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    error?: string;
    value?: {
      phase: string;
      message: {
        role: string;
        content?: string;
        tool_calls?: {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }[];
      };
    };
  };
}

describe("trusted business fixture requires actual tool feedback", () => {
  it.each(["chat", "messages"])(
    "accepts the %s review final at the production boundary",
    (protocol) => {
      const value = invoke("review", 1, {
        messages: [
          {
            role: "user",
            content:
              protocol === "chat"
                ? "Review the fixture"
                : [{ type: "text", text: "Review the fixture" }],
          },
        ],
      }).value;
      expect(value?.phase).toBe("final");
      expect(parseDshOutput(value?.message.content ?? "", "review")).toMatchObject({
        operation: "review",
        state: "final",
        findings: [
          {
            path: settings.fixturePath,
            line: 1,
            side: "RIGHT",
            confidence: 1,
          },
        ],
      });
    },
  );

  it.each(["fix", "implement"] as const)(
    "requires a single %s Bash call for either provider protocol",
    (route) => {
      const prompt = { role: "user", content: "DSH_E2E_CI_FAILURE_10/1" };
      for (const protocol of ["chat", "messages"]) {
        const first = invoke(route, 1, {
          messages: [prompt],
          tools:
            protocol === "chat"
              ? [{ function: { name: "bash" } }]
              : [{ name: "bash", input_schema: { type: "object" } }],
        }).value;
        expect(first?.phase).toBe("bash-issued");
        expect(first?.message.tool_calls).toHaveLength(1);
        const call = first?.message.tool_calls?.[0];
        expect(call?.function.name).toBe("bash");
        const argumentsValue = JSON.parse(call?.function.arguments ?? "null") as {
          command: string;
        };
        expect(argumentsValue.command).toContain(
          route === "fix" ? settings.fixturePath : settings.implementationPath,
        );
        const assistant =
          protocol === "chat"
            ? first?.message
            : {
                role: "assistant",
                content: [{ type: "tool_use", id: call?.id, name: "bash", input: argumentsValue }],
              };
        const marker = `DSH_E2E_${route.toUpperCase()}_TOOL_COMPLETED`;
        const feedback =
          protocol === "chat"
            ? { role: "tool", tool_call_id: call?.id, content: marker }
            : {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call?.id,
                    content: [{ type: "text", text: marker }],
                  },
                ],
              };
        const second = invoke(route, 2, { messages: [prompt, assistant, feedback] }).value;
        expect(second?.phase).toBe("bash-observed");
        // Consume the actual final with the Controller's strict public schema,
        // rather than validating a second copy of the fixture's own shape.
        expect(parseDshOutput(second?.message.content ?? "", route)).toMatchObject({
          operation: route,
          state: "final",
          changePlan: [
            { path: route === "fix" ? settings.fixturePath : settings.implementationPath },
          ],
        });
        if (protocol === "messages") {
          const failedFeedback = {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call?.id,
                is_error: true,
                content: [{ type: "text", text: marker }],
              },
            ],
          };
          expect(
            invoke(route, 2, { messages: [prompt, assistant, failedFeedback] }).error,
          ).toContain("one matching completed");
        }
        expect(invoke(route, 2, { messages: [prompt, feedback] }).error).toContain(
          "one matching completed",
        );
        expect(
          invoke(route, 2, { messages: [prompt, assistant, feedback, feedback] }).error,
        ).toContain("one matching completed");
        expect(invoke(route, 3, { messages: [prompt, assistant, feedback] }).error).toContain(
          "one matching completed",
        );
      }
    },
  );

  it("rejects missing CI evidence, unavailable Bash and invalid shell-bound fixture identities", () => {
    expect(invoke("fix", 1, { messages: [], tools: [{ name: "bash" }] }).error).toContain(
      "failed-check evidence",
    );
    expect(invoke("implement", 1, { messages: [], tools: [] }).error).toContain("actual DSH Bash");
    expect(
      invoke("review", 1, {}, { ...settings, fixturePath: "file'; touch anything" }).error,
    ).toContain("identity is invalid");
  });
});
