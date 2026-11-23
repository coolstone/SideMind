import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
const source = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sandbox = vm.createContext({ console, TextDecoder, Blob, URL, crypto: webcrypto, structuredClone });
for (const name of ["workflow-core.js", "pdf-context.js", "stream-reader.js"]) vm.runInContext(source(name), sandbox);
const core = sandbox.SideMindWorkflow;
const clone = (value) => JSON.parse(JSON.stringify(value));

assert.equal(core.inputBudget({ maxOutputTokens: 1000 }), core.inputBudget({ maxOutputTokens: 384000 }));
assert.equal(core.inputBudget({ inputBudgetChars: 32000 }), 32000);
assert.equal(core.checkBudget("x".repeat(3000), "system", { inputBudgetChars: 2000 }).ok, false);
assert.equal(core.checkBudget("hello", "system", {}).ok, true);

const original = Array.from({ length: 205 }, (_, i) => ({ id: `chat-${i}`, updatedAt: i, messages: Array.from({ length: 42 }, (_, n) => ({ id: `m-${i}-${n}`, role: n % 2 ? "assistant" : "user", content: `完整消息 ${n}` })) }));
let stored = { conversations: clone(original) };
const writes = [];
const storage = { async get() { return structuredClone(stored); }, async set(patch) { writes.push(structuredClone(patch)); Object.assign(stored, structuredClone(patch)); } };
await core.migrate(storage);
assert.deepEqual(stored.conversations, original);
assert.deepEqual(stored.historyBeforeV2.conversations, original);
assert.equal(writes[0].historyBeforeV2.conversations.length, 205);
assert.equal(writes[1].historyStorageVersion, 2);
await core.migrate(storage);
assert.equal(writes.length, 2, "migration is idempotent");
storage.remove = async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; };
const beforeRestore = structuredClone(stored.conversations);
await core.restore(storage, { conversations: [], savedSnippets: [{ id: "test", content: "收藏内容" }] }, ["conversations", "savedSnippets", "historyStorageVersion"]);
assert.equal(stored.conversations.length, 0);
await core.undoRestore(storage, ["conversations", "savedSnippets", "historyStorageVersion"]);
assert.deepEqual(stored.conversations, beforeRestore);
assert.equal(stored.savedSnippets, undefined);
assert.equal(stored.backupBeforeRestore, undefined);
const quotaData = { conversations: original };
await assert.rejects(core.restore({ get: async () => quotaData, set: async (patch) => { if (patch.conversations) throw Error("quota"); Object.assign(quotaData, patch); } }, { conversations: [] }, ["conversations"]), /quota/);
assert.equal(quotaData.conversations.length, 205);
assert.equal(quotaData.backupBeforeRestore.data.conversations.length, 205);
let schemaCommitted = false;
await assert.rejects(core.migrate({ get: async () => ({ conversations: original }), set: async (patch) => { if (patch.historyBeforeV2) throw Error("quota"); schemaCommitted = true; } }), /quota/);
assert.equal(schemaCommitted, false, "migration failure must preserve old schema and data");
const expanded = core.upsert(original, { id: "new", updatedAt: 999, messages: original[0].messages });
assert.equal(expanded.length, 206);
assert.equal(expanded[0].messages.length, 42);
for (const backupVersion of [1, 2]) {
  const payload = JSON.parse(JSON.stringify({ format: "sidemind-local-backup", backupVersion, data: { conversations: expanded } }));
  assert.deepEqual(clone(core.validateBackup(payload).conversations), clone(expanded));
}
assert.throws(() => core.validateBackup({ format: "sidemind-local-backup", backupVersion: 3, data: {} }), /版本/);
assert.throws(() => core.validateBackup({ format: "sidemind-local-backup", backupVersion: 2, data: { conversations: [{ id: "a", messages: [null] }] } }), /格式/);

const context = { title: "原网页", url: "https://example.test/a", text: "原材料" };
const message = { requestPrompt: "原材料\n问题", requestInstructions: "原指令", requestReasoningEffort: "high" };
const snapshot = core.snapshot({ context, enabled: true, history: original[0].messages, prompt: message.requestPrompt });
context.url = "https://example.test/b";
assert.equal(snapshot.page.url, "https://example.test/a");
assert.equal(core.replay(message).prompt, "原材料\n问题");
assert.throws(() => core.replay({ content: "old" }), /旧记录/);
const pages = Array.from({ length: 200 }, (_, i) => ({ pageNumber: i + 1, titleHint: `页 ${i + 1}`, text: `末页验证 ${i + 1} ` + "内容".repeat(600) }));
const map = sandbox.SideMindPdf.buildDocumentMap(pages);
assert.equal(map.entries.length, 200);
assert.match(map.text, /\[p\. 200\]/);
assert.ok(map.entries.every((entry) => entry.excerpt.length > 0));
assert.ok(map.text.length <= 16000);
assert.equal(map.truncated, true);
const smallMap = sandbox.SideMindPdf.buildDocumentMap(pages, 4000);
assert.equal(smallMap.entries.length, 200);
assert.ok(smallMap.text.length <= 4000);

function stream(text, bytes = 1) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += bytes) controller.enqueue(encoded.slice(i, i + bytes)); controller.close(); } });
}
const chat = 'data: {"choices":[{"index":0,"delta":{"content":"中"}}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"文"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n';
let pieces = [];
const result = await sandbox.SideMindStream.read(stream(chat), "chat", (delta) => pieces.push(delta));
assert.equal(result.text, "中文"); assert.equal(result.usage.total_tokens, 12); assert.deepEqual(pieces, ["中", "文"]);
const responses = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","usage":{"output_tokens":3}}}\n\n';
assert.equal((await sandbox.SideMindStream.read(stream(responses, 7), "responses", () => {})).text, "Hello");
pieces = [];
await assert.rejects(sandbox.SideMindStream.read(stream('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'), "chat", (delta) => pieces.push(delta)), /中断/);
assert.deepEqual(pieces, ["部分"]);
await assert.rejects(sandbox.SideMindStream.read(stream('data: {invalid}\n\n'), "chat", () => {}), /格式异常/);
await assert.rejects(sandbox.SideMindStream.read(stream('data: {"type":"response.incomplete"}\n\n'), "responses", () => {}), /未完整/);
await assert.rejects(sandbox.SideMindStream.read(stream('data: {"error":{"message":"denied"}}\n\n'), "chat", () => {}), /denied/);

// Exercise the actual save function with >200 sessions, >30 messages, and quota failure.
const elements = new Map();
const dom = { getElementById(id) { if (!elements.has(id)) elements.set(id, { value: "", removeAttribute() {}, classList: { toggle() {} }, setAttribute() {} }); return elements.get(id); } };
Object.assign(sandbox, { document: dom, navigator: {}, chrome: { storage: { local: storage } } });
vm.runInContext(source("sidepanel.js").replace(/^init\(\);$/m, ""), sandbox);
const imageUrl = "https://upload.wikimedia.org/wikipedia/commons/d/d2/Voyager.jpg";
const render = (value) => vm.runInContext("renderMarkdown(" + JSON.stringify(value) + ")", sandbox);
assert.ok(render("![旅行者](" + imageUrl + ")").includes('<img class="chat-inline-image" src="' + imageUrl + '"'));
assert.ok(render("![旅行者]\\(" + imageUrl.replace(":", "\\:") + "\\)").includes("<img "));
assert.ok(!render("`![示例](https://example.com/example.jpg)`").includes("<img "));
assert.ok(!render("![示例](javascript:alert)").includes("<img "));
assert.ok(render("[查看原图](" + imageUrl + ")").includes('<a href="' + imageUrl + '"'));
sandbox.fixture = { messages: original[0].messages, conversations: original };
vm.runInContext('Object.assign(state, { messages: fixture.messages, conversationId: "live", conversationCreatedAt: 100, settings: { maxOutputTokens: 1000 }, context: null });', sandbox);
stored.conversations[0].messages[0].content = "大".repeat(3 * 1024 * 1024);
await vm.runInContext("saveConversation()", sandbox);
assert.equal(stored.conversations.length, 206);
assert.ok(new Blob([JSON.stringify(stored.conversations)]).size > 8 * 1024 * 1024);
assert.equal(stored.conversations.find((c) => c.id === "live").messages.length, 42);
const beforeQuota = structuredClone(stored.conversations);
sandbox.chrome.storage.local = { get: storage.get, async set() { throw Error("quota"); } };
await assert.rejects(vm.runInContext("saveConversation()", sandbox), /quota/);
assert.deepEqual(stored.conversations, beforeQuota);
elements.get("promptInput").value = "草稿".repeat(50000);
vm.runInContext("updatePromptInputLimit()", sandbox);
assert.equal(elements.get("promptInput").value.length, 100000);
assert.equal(elements.get("promptLimitHint").hidden, false);
vm.runInContext('state.settings.inputBudgetChars = 2000; updatePromptInputLimit()', sandbox);
assert.equal(elements.get("promptInput").value.length, 100000);

// Request isolation, partial preservation, listener cleanup, and no automatic retry.
const listeners = new Set(); let calls = 0; let requestMode = "stop"; const logs = {};
const clientContext = vm.createContext({ Date, setInterval, clearInterval, chrome: {
  runtime: { id: "extension", onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    async sendMessage(request) {
      calls++;
      for (const fn of listeners) {
        fn({ type: "AI_PROGRESS", requestId: "other", delta: "错误会话" }, { id: "extension" });
        fn({ type: "AI_PROGRESS", requestId: request.requestId, delta: "错误来源" }, { id: "other" });
        fn({ type: "AI_PROGRESS", requestId: request.requestId, delta: "保留内容" }, { id: "extension" });
      }
      if (requestMode === "throw") throw Error("network");
      return { ok: false, cancelled: true };
    }
  }, storage: { local: { get: async () => logs, set: async (data) => Object.assign(logs, data) } }
} });
vm.runInContext(source("model-client.js"), clientContext);
let visible = "";
const cancelled = await clientContext.SideMindModelClient.request({ requestId: "r", payload: { prompt: "private" } }, { onText: (text) => { visible = text; } });
assert.equal(cancelled.status, "stopped"); assert.equal(visible, "保留内容"); assert.equal(listeners.size, 0); assert.equal(calls, 1);
requestMode = "throw";
const failed = await clientContext.SideMindModelClient.request({ requestId: "r2", payload: {} });
assert.equal(failed.partialText, "保留内容"); assert.equal(failed.status, "failed"); assert.equal(calls, 2);
assert.ok(!JSON.stringify(logs).includes("private")); assert.ok(!JSON.stringify(logs).includes("保留内容"));
console.log("SideMind workflow behavior checks: OK");
