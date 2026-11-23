/* SSE decoding shared by the extension service worker and offline tests. */
globalThis.SideMindStream = {
  async read(body, mode, onDelta) {
    if (!body?.getReader) throw new Error("服务未提供可读取的流，请手动重试普通模式。");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", text = "", usage = null, responseId = null, completed = false;
    const event = async (block) => {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      if (data === "[DONE]") { completed = true; return; }
      let item;
      try { item = JSON.parse(data); } catch { throw new Error("流式数据格式异常，已保留收到的内容。"); }
      if (item.error || item.type === "error" || item.type === "response.failed") throw new Error(item.error?.message || item.response?.error?.message || item.message || "模型生成失败");
      if (item.type === "response.incomplete") {
        const reason = item.response?.incomplete_details?.reason;
        if (reason === "max_output_tokens") throw new Error("已达到本次请求的最大输出 Token。");
        if (reason === "content_filter") throw new Error("服务商因内容过滤提前结束了回答。");
        throw new Error("回答未完整生成" + (reason ? `（服务商原因：${reason}）` : "（服务商未说明原因）"));
      }
      const choice = item.choices?.find((choice) => choice.index === 0) || item.choices?.[0];
      const delta = mode === "responses"
        ? (["response.output_text.delta", "response.refusal.delta"].includes(item.type) ? item.delta : "")
        : choice?.delta?.content || choice?.delta?.refusal || "";
      if (typeof delta === "string" && delta) { text += delta; await onDelta(delta); }
      usage = item.usage || item.response?.usage || usage;
      responseId = item.response?.id || item.id || responseId;
      if (item.type === "response.completed") completed = true;
      if (choice?.finish_reason === "length") throw new Error("已达到最大输出 Token，部分回答已保留。");
      if (choice?.finish_reason === "content_filter") throw new Error("服务商中止了回答，部分内容已保留。");
      if (choice?.finish_reason) completed = true;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          await event(block);
        }
        if (buffer.length > 2 * 1024 * 1024) throw new Error("流式事件过大，已停止读取。");
        if (done) break;
      }
      if (buffer.trim()) await event(buffer);
      if (!completed) throw new Error("连接在回答结束前中断，已保留部分内容。可手动重试。");
      if (!text) throw new Error("模型没有返回可显示的文本");
      return { text, usage, responseId };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
};
