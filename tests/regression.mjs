import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");

const noopEvent = { addListener() {} };
let bridgeSendCount = 0;
let bridgeInjectionCount = 0;
const chrome = {
  runtime: {
    id: "test-extension",
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: noopEvent,
    getURL: (value = "") => `chrome-extension://test-extension/${value.replace(/^\//, "")}`
  },
  contextMenus: { onClicked: noopEvent },
  commands: { onCommand: noopEvent },
  tabs: {
    async sendMessage() {
      bridgeSendCount += 1;
      if (bridgeSendCount === 1) throw new Error("Receiving end does not exist");
      return { ok: true };
    }
  },
  scripting: {
    async executeScript() { bridgeInjectionCount += 1; },
    async insertCSS() {}
  },
  storage: {
    local: {
      async get() {
        return {
          settings: {
            provider: "ollama",
            apiMode: "chat",
            baseUrl: "http://127.0.0.1:11434",
            model: "local-test",
            apiKey: "",
            maxOutputTokens: 100
          }
        };
      }
    }
  }
};

const context = vm.createContext({
  chrome,
  URL,
  AbortController,
  Blob,
  crypto: { randomUUID: () => "generated-request-id" },
  fetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }),
  console,
  setTimeout,
  clearTimeout
});
new vm.Script(backgroundSource, { filename: "background.js" }).runInContext(context);

const evaluate = (source) => vm.runInContext(source, context);

const textOnly = evaluate(`buildChatBody(
  { provider: "compatible", model: "local-model", maxOutputTokens: 2000 },
  { instructions: "system", prompt: "hello", reasoningEffort: "max", imageDataUrls: [] }
)`);
assert.equal(textOnly.messages[1].content, "hello", "text-only chat content should remain a string");
assert.equal("reasoning_effort" in textOnly, false, "custom compatible APIs should not receive unknown reasoning fields");

const openAIWithImage = evaluate(`buildChatBody(
  { provider: "openai", model: "gpt-test", maxOutputTokens: 2400 },
  { instructions: "system", prompt: "inspect", reasoningEffort: "high", imageDataUrls: ["data:image/png;base64,AAAA"] }
)`);
assert.ok(Array.isArray(openAIWithImage.messages[1].content));
assert.equal(openAIWithImage.messages[1].content[1].type, "image_url");
assert.equal(openAIWithImage.reasoning_effort, "high");

const deepSeekOff = evaluate(`buildChatBody(
  { provider: "deepseek", model: "deepseek-test", maxOutputTokens: 3000 },
  { instructions: "system", prompt: "hello", reasoningEffort: "none" }
)`);
assert.equal(deepSeekOff.thinking.type, "disabled");
assert.equal("reasoning_effort" in deepSeekOff, false);

const deepSeekMax = evaluate(`buildChatBody(
  { provider: "deepseek", model: "deepseek-test", maxOutputTokens: 3000 },
  { instructions: "system", prompt: "hello", reasoningEffort: "max" }
)`);
assert.equal(deepSeekMax.thinking.type, "enabled");
assert.equal(deepSeekMax.reasoning_effort, "max");

const visionSchemaError = evaluate(`readableError(new Error("Failed to deserialize: unknown variant image_url, expected text"))`);
assert.match(visionSchemaError, /当前模型接口只支持文本/);

const capturePermissionError = evaluate(`readableError(new Error("Either the '<all_urls>' or 'activeTab' permission is required."))`);
assert.match(capturePermissionError, /页面截图权限尚未生效/);

const userCancelledError = evaluate(`(() => {
  const error = new Error("模型请求已由用户停止");
  error.code = "USER_CANCELLED";
  return readableError(error);
})()`);
assert.equal(userCancelledError, "已停止生成");

assert.equal(evaluate(`buildEndpoint("http://192.168.110.4:11434", "chat", "ollama")`), "http://192.168.110.4:11434/v1/chat/completions");
assert.equal(evaluate(`buildEndpoint("http://192.168.110.4:11434/v1", "chat", "ollama")`), "http://192.168.110.4:11434/v1/chat/completions");
assert.equal(evaluate(`buildEndpoint("https://example.test/v1", "chat", "compatible")`), "https://example.test/v1/chat/completions");

const cancelledRequest = evaluate(`callModel(
  { instructions: "system", prompt: "hello", imageDataUrls: [], reasoningEffort: "none" },
  "cancel-test"
).catch((error) => ({ code: error.code, readable: readableError(error) }))`);
assert.equal(evaluate(`activeModelRequests.has("cancel-test")`), true, "request should be cancellable before settings finish loading");
evaluate(`(() => {
  const request = activeModelRequests.get("cancel-test");
  request.userCancelled = true;
  request.controller.abort();
})()`);
const cancelledResult = await cancelledRequest;
assert.equal(cancelledResult.code, "USER_CANCELLED");
assert.equal(cancelledResult.readable, "已停止生成");
assert.equal(evaluate(`activeModelRequests.has("cancel-test")`), false);

const responses = evaluate(`buildResponsesBody(
  { model: "gpt-test", maxOutputTokens: 4096 },
  { instructions: "system", prompt: "hello", reasoningEffort: "max" }
)`);
assert.equal(responses.reasoning.effort, "max");
assert.equal(responses.max_output_tokens, 4096);

const bridgeResult = await evaluate(`sendTabMessageWithBridge(42, { type: "PING" })`);
assert.equal(bridgeResult.ok, true);
assert.equal(bridgeSendCount, 2, "a missing old content script should be retried once");
assert.equal(bridgeInjectionCount, 1, "the current content script should be injected before retrying");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.version, "0.5.18");
assert.ok(manifest.permissions.includes("scripting"));
assert.ok(manifest.host_permissions.includes("<all_urls>"));
assert.ok(manifest.content_scripts[0].matches.includes("file:///*"));
assert.equal(manifest.icons["128"], "assets/logo-128.png");
assert.equal(manifest.action.default_icon["16"], "assets/logo-16.png");
for (const size of [16, 32, 48, 128]) {
  assert.ok(fs.existsSync(path.join(root, `assets/logo-${size}.png`)), `missing ${size}px logo`);
}
assert.ok(fs.existsSync(path.join(root, "assets/logo-wordmark.svg")));
assert.ok(fs.existsSync(path.join(root, "assets/logo-wordmark.png")));
assert.ok(fs.existsSync(path.join(root, "assets/donate-wechat.jpg")));
assert.ok(fs.existsSync(path.join(root, "assets/donate-alipay.jpg")));
const usageGuide = fs.readFileSync(path.join(root, "SideMind-使用与扩展指南.md"), "utf8");
assert.match(usageGuide, /使用压缩包安装到 Chrome/);
assert.match(usageGuide, /为什么做 SideMind/);
assert.match(usageGuide, /最开始的年度订阅最高约为 999 元/);
assert.match(usageGuide, /最低档也已经到了 1699 元/);
assert.match(usageGuide, /功能来自长期使用中最常出现的实际需求/);
assert.match(usageGuide, /配置 DeepSeek API Key/);
assert.match(usageGuide, /与在线 Markdown 工具联动/);
assert.match(usageGuide, /方便自己继续扩展/);
assert.match(usageGuide, /允许访问文件网址/);
assert.match(backgroundSource, /const panelPromise = openPanel\(sender\.tab\);\s+importChatGPTResponse\(message\.text, panelPromise\)/);
assert.match(backgroundSource, /Promise\.allSettled\(\[panelPromise, storePromise\]\)/);
assert.match(backgroundSource, /function isFileSchemeAccessAllowed/);
assert.match(backgroundSource, /允许访问文件网址/);
assert.match(backgroundSource, /backupReminderPending/);
assert.match(backgroundSource, /chrome\.runtime\.openOptionsPage/);
assert.match(backgroundSource, /activeModelRequests/);
assert.match(backgroundSource, /CANCEL_AI_REQUEST/);
assert.match(backgroundSource, /OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
assert.match(backgroundSource, /provider === "ollama"/);
assert.match(backgroundSource, /\/v1\/chat\/completions/);
assert.doesNotMatch(backgroundSource, /await chrome\.storage\.session\.set\([\s\S]{0,220}await openPanel\(tab\)/);

const contentStyleSource = fs.readFileSync(path.join(root, "content.css"), "utf8");

for (const filename of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, filename), "utf8");
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${filename} contains duplicate element ids`);
}

const sidepanelSource = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
assert.match(sidepanelSource, /MAX_ATTACHMENT_TOTAL_BYTES = 5 \* 1024 \* 1024/);
assert.match(sidepanelSource, /!ui\.promptInput\.value\.trim\(\) && !state\.attachments\.length/);
assert.match(sidepanelSource, /addEventListener\("paste"/);
assert.match(sidepanelSource, /async function handleComposerPaste/);
assert.match(sidepanelSource, /item\.kind === "file" && item\.type\.startsWith\("image\/"\)/);
assert.match(sidepanelSource, /已粘贴 \$\{added\} 张图片/);
assert.match(sidepanelSource, /function addFilesToAttachments/);
assert.match(sidepanelSource, /function ensureImageInputSupported/);
assert.match(sidepanelSource, /function isKnownTextOnlyProfile/);
assert.match(sidepanelSource, /DeepSeek V4 只支持文本；图片已保留/);
assert.match(sidepanelSource, /togglePopover\("model"\)/);
assert.match(sidepanelSource, /async function exportCurrentSpaceHistory/);
assert.match(sidepanelSource, /function buildHistoryExportMarkdown/);
assert.match(sidepanelSource, /async function importHistoryFile/);
assert.match(sidepanelSource, /conversationImportKey/);
assert.match(sidepanelSource, /SideMind-聊天历史-/);
assert.match(sidepanelSource, /附件文件本身未保存在聊天历史中/);
assert.match(sidepanelSource, /function bindControlTooltips/);
assert.match(sidepanelSource, /function applyFontSize/);
assert.match(sidepanelSource, /function beginModelRequest/);
assert.match(sidepanelSource, /async function stopActiveRequest/);
assert.match(sidepanelSource, /CANCEL_AI_REQUEST/);
assert.match(sidepanelSource, /activeRequestId/);
assert.match(sidepanelSource, /is-stop/);
assert.match(sidepanelSource, /builtin-deepseek-pro/);
assert.match(sidepanelSource, /model-provider-group/);
assert.match(sidepanelSource, /function providerLabel/);
assert.match(sidepanelSource, /function openDonationDialog/);
assert.match(sidepanelSource, /function setDonationMethod/);
assert.match(sidepanelSource, /function showControlTooltip/);
assert.match(sidepanelSource, /aria-describedby/);
assert.match(sidepanelSource, /controlTooltipTimer/);
assert.match(sidepanelSource, /window\.confirm\(/);
for (const tool of ["copy", "save", "quote", "regenerate", "share", "speak", "insert", "delete"]) {
  assert.match(sidepanelSource, new RegExp(`messageToolButton\\(\\"${tool}\\"`), `missing assistant action: ${tool}`);
}
assert.match(sidepanelSource, /data-code-copy/);
assert.match(sidepanelSource, /async function regenerateAssistantMessage/);
assert.match(sidepanelSource, /function saveMessageToLocalFile/);
assert.match(sidepanelSource, /async function deleteAssistantMessage/);
assert.match(sidepanelSource, /确定删除这条回答吗？此操作无法撤销。/);
assert.match(sidepanelSource, /localArtifacts\.filter\(\(item\) => item\.messageId !== message\.id\)/);
assert.match(sidepanelSource, /text\/markdown;charset=utf-8/);
assert.match(sidepanelSource, /URL\.revokeObjectURL/);
assert.match(sidepanelSource, /currentResponseLanguage\(\)/);
assert.match(sidepanelSource, /requestTemplateVariables/);
assert.match(sidepanelSource, /slice\(0, 5\)/);
assert.match(sidepanelSource, /updateSelectionPreview/);
assert.match(sidepanelSource, /PAGE_SELECTION_CHANGED/);
assert.match(sidepanelSource, /当前未发送的文字或附件将被清空/);
assert.match(sidepanelSource, /async function restoreConversation\(conversation, \{ skipConfirmation = false, showFeedback = false \} = \{\}\)/);
assert.match(sidepanelSource, /if \(!startNewChat\(\{ skipConfirmation \}\)\) return false/);
assert.match(sidepanelSource, /async function editConversationTitle/);
assert.match(sidepanelSource, /titleCustomized/);
assert.match(sidepanelSource, /state\.conversationTitle = conversation\.title/);
assert.match(sidepanelSource, /修改聊天标题/);
assert.match(sidepanelSource, /async function applyStartupBehavior/);
assert.match(sidepanelSource, /startupBehavior === "new_chat"/);
assert.match(sidepanelSource, /lastConversationId/);
assert.match(sidepanelSource, /renderHistory\(\{ focusCurrent: true \}\)/);
assert.match(sidepanelSource, /scrollIntoView\(\{ block: "center" \}\)/);
assert.match(sidepanelSource, /function extractGeneratedArtifacts/);
assert.match(sidepanelSource, /function createArtifactShelf/);
assert.match(sidepanelSource, /chrome\.runtime\.getURL\(`artifact\.html\?id=/);
assert.match(sidepanelSource, /localArtifacts/);
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.doesNotMatch(sidepanelSource, /focusModeButton|toggleFocusMode/);
assert.doesNotMatch(contentSource, /TOGGLE_FOCUS_MODE|sidemind-focus-mode/);
assert.doesNotMatch(contentStyleSource, /sidemind-focus-mode/);
assert.match(contentSource, /location\.protocol === "file:"/);
assert.match(contentSource, /decodeURIComponent\(location\.pathname/);
assert.match(contentSource, /if \(!onChatGPT\) return;\s+if \(document\.getElementById\("sidemind-chatgpt-sync"\)\) return;/);
assert.match(contentSource, /回答已保存；请点击 SideMind 扩展图标打开侧栏/);
assert.match(backgroundSource, /当前模型接口只支持文本，不能直接接收图片/);
const artifactFunctionsStart = sidepanelSource.indexOf("function extractGeneratedArtifacts");
const artifactFunctionsEnd = sidepanelSource.indexOf("async function openArtifact", artifactFunctionsStart);
assert.ok(artifactFunctionsStart > 0 && artifactFunctionsEnd > artifactFunctionsStart);
const artifactFunctionsContext = vm.createContext({});
new vm.Script(`${sidepanelSource.slice(artifactFunctionsStart, artifactFunctionsEnd)}\n;globalThis.__artifactTools = { extractGeneratedArtifacts };`).runInContext(artifactFunctionsContext);
const artifactTools = artifactFunctionsContext.__artifactTools;
const htmlArtifacts = artifactTools.extractGeneratedArtifacts("```html\n<!doctype html><html><head><title>示例页面</title></head><body></body></html>\n```");
assert.equal(htmlArtifacts.length, 1);
assert.equal(htmlArtifacts[0].title, "示例页面");
assert.equal(htmlArtifacts[0].previewable, true);
assert.equal(artifactTools.extractGeneratedArtifacts("```json\n{\"name\":\"数据工件\"}\n```")[0].extension, "json");
assert.equal(artifactTools.extractGeneratedArtifacts("```python\nprint('not supported yet')\n```").length, 0);

const templateVariablesSource = fs.readFileSync(path.join(root, "template-variables.js"), "utf8");
const templateVariablesContext = vm.createContext({});
new vm.Script(`${templateVariablesSource}\n;globalThis.__templateVariables = { extractTemplateVariables, interpolatePromptTemplate, templateVariableLabel };`).runInContext(templateVariablesContext);
const templateVariables = templateVariablesContext.__templateVariables;
assert.deepEqual(Array.from(templateVariables.extractTemplateVariables("用 ${lang} 处理 ${input}，再次使用 ${lang}")), ["lang", "input"]);
assert.equal(templateVariables.interpolatePromptTemplate("请用 ${lang} 处理：${input}", { lang: "简体中文", input: "示例" }), "请用 简体中文 处理：示例");
assert.equal(templateVariables.interpolatePromptTemplate("保留 ${missing}", {}), "保留 ${missing}");

const historyTransferSource = fs.readFileSync(path.join(root, "history-transfer.js"), "utf8");
const historyTransferContext = vm.createContext({ console });
new vm.Script(historyTransferSource).runInContext(historyTransferContext);
const importedHistory = historyTransferContext.SideMindHistory.parseHistoryMarkdown(`# SideMind 聊天历史：默认空间

- 导出时间：2026/7/19 16:04:24
- 会话数量：1

---

## 1. 测试记录

- 创建时间：2026/7/19 13:48:23
- 更新时间：2026/7/19 13:49:23
- 关联网页：示例页面
- 网页地址：https://example.com/

### 用户 · 2026/7/19 13:48:23

请总结

### SideMind · deepseek-v4-flash · 2026/7/19 13:49:23

这是回答。

---`);
assert.equal(importedHistory.spaceName, "默认空间");
assert.equal(importedHistory.conversations.length, 1);
assert.equal(importedHistory.conversations[0].messages.length, 2);
assert.equal(importedHistory.conversations[0].messages[1].modelName, "deepseek-v4-flash");
assert.equal(importedHistory.conversations[0].url, "https://example.com/");

const promptLibrarySource = fs.readFileSync(path.join(root, "prompt-library.js"), "utf8");
const promptLibraryContext = vm.createContext({});
new vm.Script(`${promptLibrarySource}\n;globalThis.__promptLibrary = { DEFAULT_PROMPTS, PROMPT_LIBRARY_VERSION, mergePromptLibrary };`).runInContext(promptLibraryContext);
const promptLibrary = promptLibraryContext.__promptLibrary;
assert.equal(promptLibrary.PROMPT_LIBRARY_VERSION, 5);
for (const name of ["百字总结", "总结", "翻译单词", "生成单词记忆卡片", "名师指导", "公众号文章（精华版）", "行业分析-3商业架构与生态", "行业分析-2客户与运营", "行业分析-1市场地图"]) {
  assert.ok(promptLibrary.DEFAULT_PROMPTS.some((item) => item.name === name), `missing migrated prompt: ${name}`);
}
const mergedPrompts = promptLibrary.mergePromptLibrary([{ id: "custom", name: "我的提示词", content: "keep me", category: "chat", visible: true }]);
assert.equal(mergedPrompts.filter((item) => item.name === "我的提示词").length, 1);
assert.equal(new Set(mergedPrompts.map((item) => item.name)).size, mergedPrompts.length);
const migratedBuiltIn = promptLibrary.mergePromptLibrary([{ id: "prompt-brief", name: "百字总结", content: "旧的等价模板", category: "reading", visible: false, source: "sider-equivalent" }]);
assert.equal(migratedBuiltIn.find((item) => item.id === "prompt-brief").content, "做一个100字左右的总结，不超过120字。");
assert.equal(migratedBuiltIn.find((item) => item.id === "prompt-brief").visible, false);
const customizedBuiltIn = promptLibrary.mergePromptLibrary([{ id: "prompt-brief", name: "百字总结", content: "我的自定义版本", category: "reading", visible: true }]);
assert.equal(customizedBuiltIn.find((item) => item.id === "prompt-brief").content, "我的自定义版本");
const exactCaptures = JSON.parse(fs.readFileSync(path.join(root, "sider-prompt-captures.json"), "utf8"));
const exactLibrary = promptLibrary.mergePromptLibrary([], exactCaptures);
assert.match(exactLibrary.find((item) => item.name === "总结").content, /\$\{lang\}/);
assert.match(exactLibrary.find((item) => item.name === "翻译单词").content, /\$\{input\}/);
assert.match(exactLibrary.find((item) => item.name === "公众号文章").content, /<!DOCTYPE html>/);
assert.match(exactLibrary.find((item) => item.name === "行业分析-1市场地图").content, /\$\{industry\}/);

const optionsHtml = fs.readFileSync(path.join(root, "options.html"), "utf8");
assert.match(optionsHtml, /id="responseLanguage"/);
assert.match(optionsHtml, /id="startupBehavior"/);
assert.match(optionsHtml, /id="fontSizeScale"/);
assert.match(optionsHtml, /id="modelPreset"/);
assert.match(optionsHtml, /舒适（推荐）/);
assert.match(optionsHtml, /deepseek-v4-pro|自定义模型 ID/);
assert.match(optionsHtml, /<option value="ollama">Ollama（本地模型）<\/option>/);
assert.match(optionsHtml, /id="apiKeyHint"/);
assert.match(optionsHtml, /先配置服务商/);
assert.match(optionsHtml, /再配置模型/);
assert.ok(optionsHtml.indexOf('id="provider"') < optionsHtml.indexOf('id="profileSelect"'));
assert.ok(optionsHtml.indexOf('id="apiKey"') < optionsHtml.indexOf('id="profileSelect"'));
assert.match(optionsHtml, /恢复上次打开的会话/);
assert.match(optionsHtml, /\$\{lang\}/);
assert.match(optionsHtml, /id="backupInstallNotice"/);
assert.match(optionsHtml, /id="includeApiKeysInBackup"/);
assert.match(optionsHtml, /id="importBackupButton"/);
assert.match(optionsHtml, /id="exportBackupButton"/);
const optionsSource = fs.readFileSync(path.join(root, "options.js"), "utf8");
assert.match(optionsSource, /responseLanguage/);
assert.match(optionsSource, /startupBehavior/);
assert.match(optionsSource, /builtin-deepseek/);
assert.match(optionsSource, /builtin-deepseek-pro/);
assert.match(optionsSource, /ollama/);
assert.match(optionsSource, /function updateApiKeyRequirement/);
assert.match(optionsSource, /OLLAMA_ORIGINS/);
assert.match(optionsSource, /PROVIDER_MODELS/);
assert.match(optionsSource, /function inheritProviderApiKeys/);
assert.match(optionsSource, /function renderModelChoices/);
assert.match(optionsSource, /function profilesForProvider/);
assert.match(optionsSource, /function switchProvider/);
assert.match(optionsSource, /const sharedConnection/);
assert.match(optionsSource, /function normalizeFontSizeScale/);
assert.match(optionsSource, /MODEL_PROFILE_LIBRARY_VERSION/);
assert.match(optionsSource, /BACKUP_FORMAT = "sidemind-local-backup"/);
assert.match(optionsSource, /async function exportLocalBackup/);
assert.match(optionsSource, /async function importLocalBackup/);
assert.match(optionsSource, /function removeApiKeys/);
assert.match(optionsSource, /function preserveCurrentApiKeys/);
const modelConstantsStart = optionsSource.indexOf("const MODEL_PROFILE_LIBRARY_VERSION");
const modelConstantsEnd = optionsSource.indexOf("const PROVIDER_PRESETS", modelConstantsStart);
const modelFunctionsStart = optionsSource.indexOf("function mergeBuiltInProfiles");
const modelFunctionsEnd = optionsSource.indexOf("function profileFromValues", modelFunctionsStart);
const modelConfigContext = vm.createContext({});
new vm.Script(`${optionsSource.slice(modelConstantsStart, modelConstantsEnd)}\n${optionsSource.slice(modelFunctionsStart, modelFunctionsEnd)}\n;globalThis.__modelProfiles = { mergeBuiltInProfiles };`).runInContext(modelConfigContext);
const migratedProfiles = modelConfigContext.__modelProfiles.mergeBuiltInProfiles([
  { id: "builtin-deepseek", name: "DeepSeek · V4 Flash", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "secret", model: "deepseek-v4-flash" }
], 1);
assert.equal(migratedProfiles.filter((profile) => profile.model === "deepseek-v4-flash").length, 1);
assert.equal(migratedProfiles.find((profile) => profile.model === "deepseek-v4-pro").apiKey, "secret");
const migratedOllama = modelConfigContext.__modelProfiles.mergeBuiltInProfiles([
  { id: "local", name: "本地 Gemma", provider: "compatible", apiMode: "chat", baseUrl: "http://192.168.110.4:11434", apiKey: "", model: "gemma4:31b" }
], 3);
assert.equal(migratedOllama.find((profile) => profile.id === "local").provider, "ollama");
const sidepanelStyle = fs.readFileSync(path.join(root, "sidepanel.css"), "utf8");
assert.match(sidepanelStyle, /data-font-size="compact"/);
assert.match(sidepanelStyle, /data-font-size="large"/);
assert.match(sidepanelStyle, /data-font-size="extra_large"/);
assert.match(sidepanelStyle, /\.message-bubble,[\s\S]*\.composer textarea \{ font-size: var\(--font-base\); \}/);
const promptsSource = fs.readFileSync(path.join(root, "prompts.js"), "utf8");
assert.match(promptsSource, /async function movePrompt/);
assert.match(promptsSource, /function handleDragStart/);
assert.match(promptsSource, /提示词顺序已保存/);
const promptsHtml = fs.readFileSync(path.join(root, "prompts.html"), "utf8");
assert.match(promptsHtml, /拖动卡片左侧手柄调整顺序/);
const sidepanelHtml = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
assert.match(sidepanelHtml, /id="promptOverflowButton"/);
assert.match(sidepanelHtml, /id="selectionPreview"/);
assert.match(sidepanelHtml, /id="newChatActionButton"/);
assert.match(sidepanelHtml, /id="exportHistoryButton"/);
assert.match(sidepanelHtml, /id="importHistoryButton"/);
assert.match(sidepanelHtml, /id="importHistoryInput"/);
assert.match(sidepanelHtml, /导出当前空间/);
assert.match(sidepanelHtml, /id="controlTooltip" role="tooltip"/);
assert.match(sidepanelHtml, /id="donationButton"/);
assert.match(sidepanelHtml, /id="donationDialog"/);
assert.match(sidepanelHtml, /assets\/donate-wechat\.jpg/);
assert.match(sidepanelHtml, /assets\/donate-alipay\.jpg/);
assert.match(sidepanelHtml, /data-tooltip="新聊天：清空当前内容并开始新会话"/);
assert.match(sidepanelHtml, /data-tooltip="发送消息：Enter 发送，Shift \+ Enter 换行"/);
assert.match(sidepanelHtml, /class="stop-icon"/);
assert.ok(sidepanelHtml.indexOf("composer-toolbar") < sidepanelHtml.indexOf('id="newChatActionButton"'));
assert.ok(sidepanelHtml.indexOf("composer-toolbar") < sidepanelHtml.indexOf('id="historyButton"'));
assert.ok(sidepanelHtml.indexOf('id="newChatActionButton"') < sidepanelHtml.indexOf('id="historyButton"'));
assert.ok(sidepanelHtml.indexOf('id="historyButton"') < sidepanelHtml.indexOf('id="reasoningButton"'));
assert.ok(sidepanelHtml.indexOf('id="reasoningButton"') < sidepanelHtml.indexOf('id="readPageButton"'));
assert.ok(sidepanelHtml.indexOf("composer-actions") < sidepanelHtml.indexOf('id="connectionModeSelect"'));
assert.match(sidepanelHtml, /<option value="chatgpt_web">网页<\/option>/);
assert.match(sidepanelHtml, /class="brand-mark" src="assets\/logo\.svg"/);
assert.ok(sidepanelHtml.indexOf("template-variables.js") < sidepanelHtml.indexOf("prompt-library.js"));
assert.ok(sidepanelHtml.indexOf("prompt-library.js") < sidepanelHtml.indexOf("sidepanel.js"));
assert.ok(sidepanelHtml.indexOf("history-transfer.js") < sidepanelHtml.indexOf("sidepanel.js"));

const artifactHtml = fs.readFileSync(path.join(root, "artifact.html"), "utf8");
const artifactSource = fs.readFileSync(path.join(root, "artifact.js"), "utf8");
assert.match(artifactHtml, /id="viewMode"/);
assert.match(artifactHtml, /id="codeEditor"/);
assert.match(artifactHtml, /id="previewFrame" sandbox=""/);
assert.match(artifactSource, /Content-Security-Policy/);
assert.match(artifactSource, /default-src 'none'/);
assert.match(artifactSource, /chrome\.storage\.local/);
assert.match(artifactSource, /function downloadArtifact/);

console.log("SideMind regression checks: OK");
