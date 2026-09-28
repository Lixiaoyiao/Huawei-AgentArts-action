// Messages-protocol transport for trusted deterministic E2E providers. The
// callers own their scenario state and acceptance checks; this only frames IO.
export function sendMessages(response, content, stream) {
  const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  const message = {
    id: "msg_dsh_e2e_fixture",
    type: "message",
    role: "assistant",
    model: "dsh-e2e-fixture",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 3 },
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (value) =>
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
  for (const [index, block] of content.entries()) {
    const text = block.type === "text";
    event({
      type: "content_block_start",
      index,
      content_block: text ? { type: "text", text: "" } : { ...block, input: {} },
    });
    event({
      type: "content_block_delta",
      index,
      delta: text
        ? { type: "text_delta", text: block.text }
        : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    });
    event({ type: "content_block_stop", index });
  }
  event({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  event({ type: "message_stop" });
  response.end();
}
