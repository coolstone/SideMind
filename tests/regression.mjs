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
  }
};

const context = vm.createContext({
  chrome,
  URL,
  AbortController,
  Blob,
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
assert.equal(manifest.version, "0.5.4");
assert.ok(manifest.permissions.includes("scripting"));
assert.equal(manifest.icons["128"], "assets/logo-128.png");
assert.equal(manifest.action.default_icon["16"], "assets/logo-16.png");
for (const size of [16, 32, 48, 128]) {
  assert.ok(fs.existsSync(path.join(root, `assets/logo-${size}.png`)), `missing ${size}px logo`);
}
assert.ok(fs.existsSync(path.join(root, "assets/logo-wordmark.svg")));
assert.ok(fs.existsSync(path.join(root, "assets/logo-wordmark.png")));
assert.match(backgroundSource, /const panelPromise = openPanel\(sender\.tab\);\s+importChatGPTResponse\(message\.text, panelPromise\)/);
assert.match(backgroundSource, /Promise\.allSettled\(\[panelPromise, storePromise\]\)/);
assert.doesNotMatch(backgroundSource, /await chrome\.storage\.session\.set\([\s\S]{0,220}await openPanel\(tab\)/);

for (const filename of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, filename), "utf8");
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${filename} contains duplicate element ids`);
}

const sidepanelSource = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
assert.match(sidepanelSource, /MAX_ATTACHMENT_TOTAL_BYTES = 5 \* 1024 \* 1024/);
assert.match(sidepanelSource, /!ui\.promptInput\.value\.trim\(\) && !state\.attachments\.length/);
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
assert.match(sidepanelSource, /function restoreConversation\(conversation\) \{\s+if \(!startNewChat\(\)\) return;/);
assert.match(sidepanelSource, /async function editConversationTitle/);
assert.match(sidepanelSource, /titleCustomized/);
assert.match(sidepanelSource, /state\.conversationTitle = conversation\.title/);
assert.match(sidepanelSource, /修改聊天标题/);
assert.match(sidepanelSource, /function extractGeneratedArtifacts/);
assert.match(sidepanelSource, /function createArtifactShelf/);
assert.match(sidepanelSource, /chrome\.runtime\.getURL\(`artifact\.html\?id=/);
assert.match(sidepanelSource, /localArtifacts/);
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.match(contentSource, /if \(!onChatGPT\) return;\s+if \(document\.getElementById\("sidemind-chatgpt-sync"\)\) return;/);
assert.match(contentSource, /回答已保存；请点击 SideMind 扩展图标打开侧栏/);
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
assert.match(optionsHtml, /\$\{lang\}/);
const optionsSource = fs.readFileSync(path.join(root, "options.js"), "utf8");
assert.match(optionsSource, /responseLanguage/);
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
assert.match(sidepanelHtml, /class="brand-mark" src="assets\/logo\.svg"/);
assert.ok(sidepanelHtml.indexOf("template-variables.js") < sidepanelHtml.indexOf("prompt-library.js"));
assert.ok(sidepanelHtml.indexOf("prompt-library.js") < sidepanelHtml.indexOf("sidepanel.js"));

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
