/* Request-scoped extension transport. A failed request is never retried automatically. */
globalThis.SideMindModelClient = {
  async request(request, { onText = () => {}, onStatus = () => {} } = {}) {
    let text = "", firstTokenAt = null;
    const startedAt = Date.now();
    const renderStatus = () => onStatus({ phase: firstTokenAt ? "生成中" : "连接中", elapsedMs: Date.now() - startedAt });
    const listener = (message, sender) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "AI_PROGRESS" || message.requestId !== request.requestId) return;
      if (typeof message.delta !== "string") return;
      firstTokenAt ??= Date.now();
      text += message.delta;
      onText(text);
      renderStatus();
    };
    chrome.runtime.onMessage.addListener(listener);
    const timer = setInterval(renderStatus, 1000);
    renderStatus();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ ...request, type: "AI_REQUEST", payload: { ...request.payload, stream: request.payload.stream !== false } });
      if (response?.ok) {
        text = response.result.text;
        firstTokenAt ??= Date.now();
        onText(text);
      }
    } catch (error) {
      response = { ok: false, error: error.message || "连接中断" };
    } finally {
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(listener);
    }
    const status = response?.ok ? "completed" : response?.cancelled ? "stopped" : "failed";
    const metrics = { startedAt, firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, elapsedMs: Date.now() - startedAt, status };
    onStatus({ phase: ({ completed: "已完成", stopped: "已停止", failed: "失败" })[status], elapsedMs: metrics.elapsedMs });
    // Metrics intentionally contain no prompt, credentials, URL, or response text.
    try {
      const { requestTimings = [] } = await chrome.storage.local.get("requestTimings");
      await chrome.storage.local.set({ requestTimings: [...requestTimings.slice(-99), metrics] });
    } catch { /* Diagnostic persistence must not fail the user's answer. */ }
    return { ...response, partialText: text, metrics, status };
  }
};
