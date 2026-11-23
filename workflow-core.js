/* Local workflow primitives. No network or model credentials. */
globalThis.SideMindWorkflow = (() => {
  const STORAGE_VERSION = 2;
  const openAIModels = ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare"];
  const isImageModel = (profile) => profile?.provider === "openai" && /^gpt-image-2\.6-(sunburst|flare)$/.test(profile.model);
  const openAIProfiles = openAIModels.filter(model => model !== "gpt-5.6-terra").map(model => ({
    id: "openai-" + model, name: model, provider: "openai", apiMode: "responses", baseUrl: "https://api.openai.com/v1",
    model, apiKey: "", maxOutputTokens: 16000, supportsVision: !model.startsWith("gpt-image-")
  }));
  function inputBudget(settings = {}) {
    if (settings.connectionMode === "chatgpt_web") return 12000;
    const value = Number(settings.inputBudgetChars);
    return Number.isFinite(value) && value >= 1000 ? Math.min(500000, Math.floor(value)) : 48000;
  }
  function checkBudget(prompt, instructions, settings) {
    const used = String(prompt || "").length + String(instructions || "").length;
    const limit = inputBudget(settings);
    return { used, limit, ok: used <= limit };
  }
  function snapshot({ context, enabled, attachments = [], history = [], pdf, prompt }) {
    let historyBudget = 15000;
    const includedHistory = [];
    for (const item of history.slice(-6)) {
      if (historyBudget <= 0) break;
      includedHistory.push(item.id);
      historyBudget -= Math.min(3000, String(item.content || "").length, historyBudget);
    }
    let attachmentBudget = 24000;
    const materialAttachments = attachments.map((item) => {
      const characters = String(item.text || "").length;
      const sentCharacters = item.kind === "text" ? Math.min(characters, 12000, attachmentBudget) : 0;
      attachmentBudget -= sentCharacters;
      return { name: item.name || "附件", kind: item.kind, characters, sentCharacters };
    });
    return {
      version: 1, createdAt: Date.now(),
      page: enabled && context ? { title: context.title || "", url: context.url || "", characters: String(context.text || "").length } : null,
      attachments: materialAttachments,
      historyIds: includedHistory,
      pdf: pdf ? { name: pdf.name, pageCount: pdf.pageCount, range: pdf.selectedRangeLabel || "全文概览", coveredPages: pdf.documentMap?.entries?.length || 0 } : null,
      truncated: Boolean(pdf?.documentMap?.truncated) || materialAttachments.some((item) => item.sentCharacters < item.characters) || /已截断|概览材料/.test(prompt),
      promptCharacters: String(prompt || "").length
    };
  }
  function replay(message) {
    if (!message?.requestPrompt || !message.requestInstructions) throw new Error("旧记录没有完整请求快照，请重新附加原材料后提问。");
    return { prompt: message.requestPrompt, instructions: message.requestInstructions, reasoningEffort: message.requestReasoningEffort || "none" };
  }
  async function migrate(storage) {
    const data = await storage.get(["historyStorageVersion", "conversations", "historyBeforeV2"]);
    if (data.historyStorageVersion >= STORAGE_VERSION) return;
    if (!Array.isArray(data.conversations) && data.conversations !== undefined) throw new Error("历史数据格式异常，请先导出备份。");
    // Keep a recovery copy before marking migration complete; existing records are unchanged.
    if (!data.historyBeforeV2) await storage.set({ historyBeforeV2: { conversations: data.conversations || [], createdAt: Date.now() } });
    await storage.set({ historyStorageVersion: STORAGE_VERSION });
  }
  function upsert(conversations, conversation) {
    return [conversation, ...conversations.filter((item) => item.id !== conversation.id)]
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }
  async function restore(storage, data, keys) {
    const before = await storage.get(keys);
    await storage.set({ backupBeforeRestore: { data: before, createdAt: Date.now() } });
    await storage.set({ savedSnippets: [], ...data, historyStorageVersion: STORAGE_VERSION, historyRestoredAt: Date.now(), backupReminderPending: false });
  }
  async function undoRestore(storage, keys) {
    const { backupBeforeRestore } = await storage.get("backupBeforeRestore");
    if (!backupBeforeRestore?.data) throw new Error("没有可撤销的恢复记录");
    const data = backupBeforeRestore.data;
    await storage.set({ ...data, historyRestoredAt: Date.now() });
    await storage.remove(keys.filter((key) => !(key in data)));
    await storage.remove("backupBeforeRestore");
  }
  function validateBackup(payload) {
    if (payload?.format !== "sidemind-local-backup" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("这不是有效的 SideMind 本地备份文件");
    if (![1, 2].includes(payload.backupVersion)) throw new Error("备份版本不受支持，请使用对应或更新版本的 SideMind。");
    for (const key of ["conversations", "savedSnippets", "spaces", "prompts", "localArtifacts"]) {
      if (payload.data[key] !== undefined && !Array.isArray(payload.data[key])) throw new Error(`备份中的 ${key} 格式异常`);
    }
    for (const conversation of payload.data.conversations || []) {
      if (!conversation?.id || !Array.isArray(conversation.messages) || conversation.messages.some((message) => !message || typeof message.content !== "string")) throw new Error("备份中的会话格式异常");
    }
    return payload.data;
  }
  return { STORAGE_VERSION, openAIModels, openAIProfiles, isImageModel, inputBudget, checkBudget, snapshot, replay, migrate, upsert, restore, undoRestore, validateBackup };
})();
