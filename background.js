const DEFAULT_SETTINGS = {
  connectionMode: "api",
  provider: "openai",
  apiMode: "responses",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.6-terra",
  apiKey: "",
  maxOutputTokens: 1800,
  activeProfileId: "default",
  modelProfiles: [],
  language: "zh-CN",
  startupBehavior: "restore_last"
};

const activeModelRequests = new Map();

const MENU_ITEMS = [
  ["ask-selection", "用 SideMind 提问：“%s”"],
  ["summarize-selection", "总结选中内容"],
  ["explain-selection", "解释选中内容"],
  ["translate-selection", "翻译选中内容"],
  ["rewrite-selection", "改写选中内容"],
  ["summarize-page", "总结当前网页"]
];

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }

  if (details?.reason === "install") {
    await chrome.storage.local.set({ backupReminderPending: true });
    chrome.runtime.openOptionsPage().catch(() => {});
  }

  await chrome.contextMenus.removeAll();
  for (const [id, title] of MENU_ITEMS) {
    chrome.contextMenus.create({
      id,
      title,
      contexts: id === "summarize-page" ? ["page"] : ["selection"]
    });
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  await restrictStorageAccess();
});

chrome.runtime.onStartup.addListener(restrictStorageAccess);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const panelPromise = openPanel(tab);
  const action = info.menuItemId === "summarize-selection"
    ? "summarizeSelection"
    : info.menuItemId.replace("-selection", "").replace("-page", "");
  await queueTask({
    action,
    selection: info.selectionText || "",
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || ""
  });
  await panelPromise;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "summarize-page" || !tab?.id) return;
  const panelPromise = openPanel(tab);
  await queueTask({ action: "summarize", tabId: tab.id, url: tab.url || "", title: tab.title || "" });
  await panelPromise;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_SIDEPANEL") {
    const tab = sender.tab;
    if (!tab?.id) {
      sendResponse({ ok: false, error: "未找到当前标签页" });
      return false;
    }
    const panelPromise = openPanel(tab);
    queueTask({ ...message.payload, tabId: tab.id, url: tab.url || "", title: tab.title || "" })
      .then(() => panelPromise)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "AI_REQUEST") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "拒绝了非扩展页面发起的模型请求" });
      return false;
    }
    callModel(message.payload, message.requestId, message.profileId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error), cancelled: error?.code === "USER_CANCELLED" }));
    return true;
  }

  if (message?.type === "CANCEL_AI_REQUEST") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "拒绝了非扩展页面发起的停止请求" });
      return false;
    }
    const request = activeModelRequests.get(String(message.requestId || ""));
    if (!request) {
      sendResponse({ ok: true, cancelled: false });
      return false;
    }
    request.userCancelled = true;
    request.controller.abort();
    sendResponse({ ok: true, cancelled: true });
    return false;
  }

  if (message?.type === "CAPTURE_TAB") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "没有截图权限" });
      return false;
    }
    captureCurrentTab(message.windowId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "READ_PAGE_CONTEXT") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "拒绝了非扩展页面发起的网页读取请求" });
      return false;
    }
    readPageContext(message.tabId)
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "CHATGPT_HANDOFF") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "拒绝了非扩展页面发起的交接请求" });
      return false;
    }
    handoffToChatGPT(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "CHATGPT_PAGE_READY") {
    if (!isChatGPTSender(sender)) {
      sendResponse({ ok: false, error: "页面来源不可信" });
      return false;
    }
    deliverPendingHandoff(sender.tab.id)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "GET_CHATGPT_RESPONSE") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "拒绝了非扩展页面发起的同步请求" });
      return false;
    }
    getLatestChatGPTResponse()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "CHATGPT_IMPORT_RESPONSE") {
    if (!isChatGPTSender(sender) || !message.text?.trim()) {
      sendResponse({ ok: false, error: "没有可同步的 ChatGPT 回答" });
      return false;
    }
    const panelPromise = openPanel(sender.tab);
    importChatGPTResponse(message.text, panelPromise)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  return false;
});

async function queueTask(task) {
  await chrome.storage.session.set({ pendingTask: { ...task, createdAt: Date.now() } });
  try {
    await chrome.runtime.sendMessage({ type: "PENDING_TASK_AVAILABLE" });
  } catch {
    // 侧边栏尚未打开时，初始化流程会从 storage.session 读取。
  }
}

async function restrictStorageAccess() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Chrome 102 以前没有 setAccessLevel；本扩展最低版本不会走到这里。
  }
}

function isTrustedExtensionSender(sender) {
  try {
    const senderUrl = sender?.url || sender?.tab?.url || "";
    return sender?.id === chrome.runtime.id &&
      new URL(senderUrl).origin === new URL(chrome.runtime.getURL("/")).origin;
  } catch {
    return false;
  }
}

function isChatGPTSender(sender) {
  try {
    const url = new URL(sender?.tab?.url || sender?.url || "");
    return sender?.id === chrome.runtime.id && url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

async function openPanel(tab) {
  if (!chrome.sidePanel?.open) return;
  return chrome.sidePanel.open({ tabId: tab.id });
}

async function captureCurrentTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 72 });
}

async function readPageContext(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("未找到可读取的标签页");
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url || "";
  const localFile = /^file:\/\//i.test(pageUrl);
  if (!/^(https?|file):\/\//i.test(pageUrl)) {
    throw new Error("浏览器内置页、扩展页和商店页面不允许读取正文");
  }
  if (localFile && !(await isFileSchemeAccessAllowed())) {
    throw new Error("要读取本地文件，请在 chrome://extensions 的 SideMind 详情中开启“允许访问文件网址”，然后重试");
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" });
    if (response?.context) return response.context;
  } catch {
    // 扩展刚安装或重新加载时，已打开的旧标签页还没有当前版本的内容脚本。
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    if (localFile) {
      throw new Error("本地文件读取权限尚未生效，请开启“允许访问文件网址”后刷新此文件页");
    }
    throw error;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  } catch {
    // 正文读取不依赖样式注入，样式失败时仍继续。
  }
  const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" });
  if (!response?.context) throw new Error("页面内容脚本已加载，但没有返回正文");
  return response.context;
}

function isFileSchemeAccessAllowed() {
  return new Promise((resolve) => {
    if (!chrome.extension?.isAllowedFileSchemeAccess) return resolve(true);
    chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(Boolean(allowed)));
  });
}

async function sendTabMessageWithBridge(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 扩展重新加载后，已打开的标签页仍可能保留旧的内容脚本上下文。
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    } catch {
      // ChatGPT 交接本身不依赖样式注入；按钮样式失败时仍可继续填入/同步。
    }
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handoffToChatGPT(payload) {
  if (!payload?.prompt?.trim()) throw new Error("没有可交接的提示词");
  await chrome.storage.session.set({
    pendingChatGPTHandoff: {
      prompt: payload.prompt,
      imageDataUrls: payload.imageDataUrls || (payload.imageDataUrl ? [payload.imageDataUrl] : []),
      createdAt: Date.now()
    }
  });

  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  let tab = tabs.find((item) => item.active) || tabs[0];
  if (tab?.id) {
    tab = await chrome.tabs.update(tab.id, { active: true });
    try {
      const delivered = await deliverPendingHandoff(tab.id);
      return { tabId: tab.id, queued: !delivered?.delivered, ...delivered };
    } catch {
      return { tabId: tab.id, queued: true };
    }
  }

  tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
  return { tabId: tab.id, queued: true };
}

async function deliverPendingHandoff(tabId) {
  const { pendingChatGPTHandoff } = await chrome.storage.session.get("pendingChatGPTHandoff");
  if (!pendingChatGPTHandoff) return { delivered: false, reason: "empty" };
  if (Date.now() - pendingChatGPTHandoff.createdAt > 10 * 60 * 1000) {
    await chrome.storage.session.remove("pendingChatGPTHandoff");
    return { delivered: false, reason: "expired" };
  }

  const response = await sendTabMessageWithBridge(tabId, {
    type: "CHATGPT_FILL",
    payload: pendingChatGPTHandoff
  });
  if (response?.ok) {
    await chrome.storage.session.remove("pendingChatGPTHandoff");
    return { delivered: true, ...response };
  }
  return { delivered: false, queued: true, error: response?.error || "提示词尚未写入", ...response };
}

async function getLatestChatGPTResponse() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  if (!tabs.length) throw new Error("没有打开的 ChatGPT 页面");
  const tab = tabs.find((item) => item.active) || tabs[0];
  const response = await sendTabMessageWithBridge(tab.id, { type: "CHATGPT_EXTRACT_LAST_RESPONSE" });
  if (!response?.ok || !response.text?.trim()) {
    throw new Error(response?.error || "当前 ChatGPT 页面还没有可同步的回答");
  }
  return { text: response.text.trim(), tabId: tab.id, title: tab.title || "ChatGPT" };
}

async function importChatGPTResponse(text, panelPromise) {
  const storePromise = chrome.storage.session.set({
    importedChatGPTResponse: { text: text.trim(), createdAt: Date.now() }
  });
  const [panelResult] = await Promise.allSettled([panelPromise, storePromise]);
  try {
    await chrome.runtime.sendMessage({ type: "CHATGPT_RESPONSE_IMPORTED", text: text.trim() });
  } catch {
    // 侧边栏尚未打开时，稍后会从 storage.session 读取。
  }
  return { panelOpened: panelResult.status === "fulfilled" };
}

async function callModel(payload, requestedId, requestedProfileId) {
  const controller = new AbortController();
  const requestId = String(requestedId || crypto.randomUUID());
  const requestState = { controller, userCancelled: false };
  activeModelRequests.set(requestId, requestState);
  const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let provider = "";
  let mode = "responses";
  let response;
  let rawText;
  try {
    const { settings: stored = {} } = await chrome.storage.local.get("settings");
    const settings = resolveModelSettings(stored, requestedProfileId);
    provider = String(settings.provider || "").toLowerCase();
    if (requestState.userCancelled) {
      const cancelledError = new Error("模型请求已由用户停止");
      cancelledError.code = "USER_CANCELLED";
      throw cancelledError;
    }
    if (!settings.apiKey && provider !== "ollama") throw new Error("请先在设置中填写 API Key");

    mode = settings.apiMode === "chat" ? "chat" : "responses";
    const endpoint = buildEndpoint(settings.baseUrl, mode, provider);
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const body = mode === "responses"
      ? buildResponsesBody(settings, payload)
      : buildChatBody(settings, payload);

    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    rawText = await response.text();
  } catch (error) {
    if (requestState.userCancelled && error?.code !== "USER_CANCELLED") {
      const cancelledError = new Error("模型请求已由用户停止");
      cancelledError.code = "USER_CANCELLED";
      throw cancelledError;
    }
    if (provider === "ollama" && error instanceof TypeError) {
      throw new Error("无法从浏览器扩展连接 Ollama。请确认服务可被局域网访问，并设置 OLLAMA_ORIGINS=chrome-extension://* 后重启 Ollama");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (activeModelRequests.get(requestId) === requestState) activeModelRequests.delete(requestId);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    if (provider === "ollama" && response.status === 403) {
      throw new Error("Ollama 拒绝了浏览器扩展来源（HTTP 403）。请在 Ollama 服务端设置 OLLAMA_ORIGINS=chrome-extension://* 并重启服务；SideMind 会自动使用 /v1/chat/completions");
    }
    throw new Error(`模型服务返回了非 JSON 内容（HTTP ${response.status}）`);
  }

  if (provider === "ollama" && response.status === 403) {
    throw new Error("Ollama 拒绝了浏览器扩展来源（HTTP 403）。请在 Ollama 服务端设置 OLLAMA_ORIGINS=chrome-extension://* 并重启服务；SideMind 会自动使用 /v1/chat/completions");
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`);
  }

  const text = mode === "responses" ? extractResponseText(data) : extractChatText(data);
  if (!text) throw new Error("模型没有返回可显示的文本");
  return { text, usage: data.usage || null, responseId: data.id || null };
}

function resolveModelSettings(stored, requestedProfileId = "") {
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const profiles = Array.isArray(stored.modelProfiles) ? stored.modelProfiles : [];
  const active = profiles.find((profile) => profile.id === (requestedProfileId || stored.activeProfileId));
  if (requestedProfileId && !active) throw new Error("指定的模型配置不存在，请在设置中重新选择");
  return active ? { ...merged, ...active, connectionMode: stored.connectionMode || merged.connectionMode } : merged;
}

function buildEndpoint(baseUrl, mode, provider = "") {
  const clean = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (/\/(responses|chat\/completions)$/.test(clean)) return clean;
  if (provider === "ollama" && !/\/v1$/.test(clean)) return `${clean}/v1/chat/completions`;
  return mode === "responses" ? `${clean}/responses` : `${clean}/chat/completions`;
}

function buildResponsesBody(settings, payload) {
  const content = [{ type: "input_text", text: payload.prompt }];
  for (const imageUrl of normalizeImageInputs(payload)) {
    content.push({ type: "input_image", image_url: imageUrl });
  }
  const body = {
    model: settings.model,
    instructions: payload.instructions,
    input: [{ role: "user", content }],
    max_output_tokens: Number(settings.maxOutputTokens) || 1800
  };
  const effort = normalizeReasoningEffort(payload.reasoningEffort);
  if (effort) body.reasoning = { effort };
  return body;
}

function buildChatBody(settings, payload) {
  const images = normalizeImageInputs(payload);
  const content = images.length
    ? [
        { type: "text", text: payload.prompt },
        ...images.map((imageUrl) => ({ type: "image_url", image_url: { url: imageUrl } }))
      ]
    : payload.prompt;
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: payload.instructions },
      { role: "user", content }
    ],
    max_tokens: Number(settings.maxOutputTokens) || 1800
  };
  const effort = normalizeReasoningEffort(payload.reasoningEffort);
  if (String(settings.provider).toLowerCase() === "deepseek") {
    body.thinking = { type: effort ? "enabled" : "disabled" };
    if (effort) body.reasoning_effort = effort === "max" ? "max" : "high";
  } else if (effort && ["openai", "openrouter"].includes(String(settings.provider).toLowerCase())) {
    body.reasoning_effort = effort;
  }
  return body;
}

function normalizeImageInputs(payload) {
  const values = Array.isArray(payload.imageDataUrls)
    ? payload.imageDataUrls
    : payload.imageDataUrl ? [payload.imageDataUrl] : [];
  return values.filter((value) => typeof value === "string" && value.startsWith("data:image/"));
}

function normalizeReasoningEffort(value) {
  return ["low", "medium", "high", "xhigh", "max"].includes(value) ? value : null;
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" || item.type === "text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || "").join("\n").trim();
  return "";
}

function readableError(error) {
  const message = error?.message || "";
  if (error?.code === "USER_CANCELLED") return "已停止生成";
  if (error?.name === "AbortError") {
    return "模型请求超过 5 分钟仍未完成，已停止等待；可降低输出 Token 或关闭深度思考后重试";
  }
  if (/<all_urls>|activeTab/i.test(message)) {
    return "页面截图权限尚未生效。请到 chrome://extensions 重新加载 SideMind，刷新当前网页后再试";
  }
  if (/unknown variant [`']?image_url|expected [`']?text/i.test(message)) {
    return "当前模型接口只支持文本，不能直接接收图片。请切换到支持视觉输入的模型，或改用 ChatGPT 网页交接模式";
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return "无法连接模型服务，请检查 Base URL、网络或接口的 CORS 设置";
  }
  return message || "未知错误";
}
