/** Emit the actual Messages SSE protocol consumed by the pinned DSH adapter. */
export function sendMessagesSse(response, delta, finishReason) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const event = (type, body) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  event("message_start", {
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
  const calls = delta.tool_calls ?? [];
  if (calls.length > 0) {
    for (const [index, call] of calls.entries()) {
      event("content_block_start", {
        index,
        content_block: { type: "tool_use", id: call.id, name: call.function.name, input: {} },
      });
      event("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: call.function.arguments },
      });
      event("content_block_stop", { index });
    }
  } else {
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: delta.content ?? "" },
    });
    event("content_block_stop", { index: 0 });
  }
  event("message_delta", {
    delta: { stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn" },
    usage: { output_tokens: 3 },
  });
  event("message_stop", {});
  response.end();
}

export function messageToolResults(request) {
  return (request.messages ?? []).flatMap(({ content }) =>
    Array.isArray(content) ? content.filter((block) => block.type === "tool_result") : [],
  );
}
