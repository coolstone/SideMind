// Run with Playwright available in NODE_PATH. Uses synthetic data; no real API calls.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 480, height: 920 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.context().addInitScript(() => {
      const listeners = new Set();
      const noopEvent = { addListener() {}, removeListener() {} };
      const profile = { id: "test", name: "测试模型", model: "local-test", provider: "ollama", apiMode: "chat", baseUrl: "http://localhost:11434", apiKey: "", inputBudgetChars: 48000, maxOutputTokens: 1000, supportsVision: true };
      const deepseek = { id: "deepseek-test", name: "DeepSeek 测试", model: "deepseek-v4-pro", provider: "deepseek", apiMode: "chat", baseUrl: "https://api.deepseek.com", apiKey: "test-key", maxOutputTokens: 1000 };
      const stored = { settings: { ...profile, connectionMode: "api", activeProfileId: "test", modelProfiles: [profile, deepseek], modelProfileLibraryVersion: 5, startupBehavior: "new_chat" }, conversations: [], prompts: [], savedSnippets: [] };
      window.testStorage = stored;
      window.testRequests = [];
      window.testMode = "success";
      window.testCancelled = false;
      window.testBalanceRequests = [];
      const storage = {
        async get(keys) { const names = typeof keys === "string" ? [keys] : keys || Object.keys(stored); return structuredClone(Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]]))); },
        async set(data) { if (window.testQuota && data.conversations) throw Error("模拟容量不足"); Object.assign(stored, structuredClone(data)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; }
      };
      window.chrome = {
        storage: { local: storage, session: { get: async () => ({}), remove: async () => {} }, onChanged: noopEvent },
        runtime: { id: "test-extension", getURL: (file) => new URL(file, location.href).href, getManifest: () => ({ version: "0.5.31" }), openOptionsPage() {},
          onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
          async sendMessage(message) {
            if (message.type === "GET_PROVIDER_BALANCE") {
              window.testBalanceRequests.push(message.profileId);
              return { ok: true, result: { provider: "deepseek", isAvailable: true, balances: [{ currency: "CNY", total: "3.38", granted: "0" }], checkedAt: Date.now() } };
            }
            if (message.type === "CANCEL_AI_REQUEST") { window.testCancelled = true; return { ok: true, cancelled: true }; }
            if (message.type === "AI_REQUEST") {
              window.testRequests.push(message); window.testCancelled = false;
              for (const delta of ["## 测试回答\n\n", "第一段内容。", "\n\n第二段内容。", "\n\n完整结论。"] ) {
                await new Promise((resolve) => setTimeout(resolve, 180));
                if (window.testCancelled) return { ok: false, cancelled: true };
                if (message.payload.stream !== false) for (const fn of listeners) fn({ type: "AI_PROGRESS", requestId: message.requestId, delta }, { id: "test-extension" });
                if (window.testMode === "failure") return { ok: false, error: "模拟断网" };
              }
              return { ok: true, result: { text: "## 测试回答\n\n第一段内容。\n\n第二段内容。\n\n完整结论。", usage: { total_tokens: 12 } } };
            }
            return { ok: true, result: { title: "测试来源", url: "https://example.test/original", text: "只属于原页面的文字材料", selection: "" } };
          }
        },
        tabs: { query: async () => [{ id: 1, url: "https://example.test/original", title: "测试来源" }], onActivated: noopEvent, onUpdated: noopEvent, create: async () => ({}) }
      };
    });
    await page.goto(`file://${path.resolve(__dirname, "../sidepanel.html")}`);
    await page.waitForFunction(() => state.settings?.model === "local-test");
    await page.locator("#modelButton").click();
    await page.waitForFunction(() => testBalanceRequests.length === 1 && document.querySelector(".model-provider-balance")?.textContent.includes("¥3.38"));
    assert.equal(await page.evaluate(() => testBalanceRequests[0]), "deepseek-test");
    await page.locator(".model-provider-balance").click();
    await page.waitForFunction(() => testBalanceRequests.length === 2);
    assert.equal(await page.evaluate(() => testBalanceRequests[1]), "deepseek-test");
    await page.locator("#modelButton").click();
    await page.locator("#promptInput").fill("解释这篇文章");
    await page.locator("#sendButton").click();
    await page.waitForFunction(() => state.messages.some((item) => item.content.includes("第一段")) && state.busy);
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.locator(".message.assistant").count(), 1);
    assert.equal(await page.evaluate(() => state.messages.filter((m) => m.role === "assistant").length), 1);
    await page.locator(".source-materials summary").click();
    assert.match(await page.locator(".source-materials").innerText(), /example.test\/original/);
    await page.evaluate(() => { state.context = { title: "另一个页面", url: "https://example.test/changed", text: "不应出现在重试材料中" }; });
    await page.locator('[data-tool="regenerate"]').last().click();
    await page.waitForFunction(() => !state.busy && testRequests.length === 2);
    assert.equal(await page.evaluate(() => testRequests[0].payload.prompt === testRequests[1].payload.prompt), true);
    await page.locator('[data-tool="favorite-snippet"]').last().click();
    await page.waitForFunction(() => testStorage.savedSnippets.length === 1);
    await page.evaluate(() => {
      const bubble = [...document.querySelectorAll(".message.assistant .message-bubble")].at(-1);
      const paragraph = bubble.querySelector("p");
      const range = document.createRange(); range.selectNodeContents(paragraph);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('[data-tool="favorite-snippet"]').last().click();
    await page.waitForFunction(() => testStorage.savedSnippets.length === 2);
    assert.equal(await page.evaluate(() => testStorage.savedSnippets[0].content), "第一段内容。");
    await page.locator("#historyButton").click();
    await page.getByRole("button", { name: "收藏片段", exact: true }).click();
    await page.locator('.snippet-dialog input').fill("第一段");
    assert.equal(await page.locator(".snippet-list article").count(), 2);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.md$/);
    await page.getByRole("button", { name: "返回原对话", exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector(".snippet-dialog"));
    await page.evaluate(() => { state.settings.inputBudgetChars = 1000; });
    await page.locator("#promptInput").fill("原草稿".repeat(600));
    assert.equal(await page.locator("#promptInput").inputValue(), "原草稿".repeat(600));
    assert.equal(await page.locator("#sendButton").isDisabled(), true);
    await page.evaluate(() => { state.settings.inputBudgetChars = 48000; });
    await page.locator("#promptInput").fill("开始一段可停止的回答");
    await page.locator("#sendButton").click();
    await page.waitForFunction(() => state.busy && state.messages.at(-1)?.content.includes("测试回答"));
    await page.locator("#sendButton").click();
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.evaluate(() => state.messages.at(-1).requestStatus), "stopped");
    assert.match(await page.evaluate(() => state.messages.at(-1).content), /测试回答/);
    await page.locator('[data-tool="retry-plain"]').last().click();
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.evaluate(() => testRequests.at(-1).payload.stream), false);
    await page.evaluate(() => {
      testStorage.conversations.push(...Array.from({ length: 205 }, (_, i) => ({ id: `test-${i}`, title: `旧会话 ${i}`, spaceId: "space-default", messages: [], updatedAt: i })));
    });
    await page.locator("#historyButton").click();
    assert.equal(await page.locator(".history-item-row").count(), 30);
    await page.getByRole("button", { name: /加载更多/ }).click();
    assert.equal(await page.locator(".history-item-row").count(), 60);
    await page.locator("#closeHistoryButton").click();
    await page.evaluate(async () => {
      addMessage("user", "这条文字还没有落盘");
      window.testQuota = true;
      await saveConversationDraft();
    });
    assert.equal(await page.locator("#historySaveFailure").count(), 1);
    const rescueDownloadPromise = page.waitForEvent("download");
    await page.locator("#historySaveFailure").getByRole("button", { name: "导出当前空间" }).click();
    const rescued = await rescueDownloadPromise;
    assert.match(fs.readFileSync(await rescued.path(), "utf8"), /这条文字还没有落盘/);
    await page.evaluate(async () => { window.testQuota = false; await saveConversationDraft(); });
    assert.equal(await page.locator("#historySaveFailure").count(), 0);
    const artifactDir = path.resolve(__dirname, "../artifacts");
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "workflow-ui.png"), fullPage: true });
    const optionsPage = await page.context().newPage();
    optionsPage.on("pageerror", (error) => errors.push(error.message));
    optionsPage.on("dialog", (dialog) => dialog.accept());
    await optionsPage.goto(`file://${path.resolve(__dirname, "../options.html")}`);
    await optionsPage.waitForFunction(() => state.profiles?.length > 0);
    await optionsPage.locator("#inputBudgetChars").fill("36000");
    await optionsPage.evaluate(() => saveSettings());
    assert.equal(await optionsPage.evaluate(() => testStorage.settings.inputBudgetChars), 36000);
    await optionsPage.evaluate(() => {
      testStorage.savedSnippets = [{ id: "snippet", spaceId: "space-default", conversationId: "old", messageId: "m", content: "收藏内容", createdAt: 1 }];
      testStorage.settings.apiKey = "test-private-key";
      testStorage.settings.modelProfiles[0].apiKey = "test-private-key";
      const timer = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => delay === 700 ? 0 : timer(fn, delay, ...args);
    });
    const backupDownloadPromise = optionsPage.waitForEvent("download");
    await optionsPage.locator("#exportBackupButton").click();
    const backup = await backupDownloadPromise;
    const backupText = fs.readFileSync(await backup.path(), "utf8");
    const payload = JSON.parse(backupText);
    assert.equal(payload.backupVersion, 2);
    assert.equal(payload.data.savedSnippets[0].content, "收藏内容");
    assert.ok(!backupText.includes("test-private-key"));
    const imported = { format: "sidemind-local-backup", backupVersion: 1, extensionVersion: "0.5.30", includesApiKeys: false, data: { conversations: [{ id: "restored", messages: [{ id: "m", role: "user", content: "恢复消息" }] }] } };
    await optionsPage.locator("#backupFileInput").setInputFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await optionsPage.waitForFunction(() => testStorage.conversations[0]?.id === "restored");
    assert.equal(await optionsPage.evaluate(() => testStorage.savedSnippets.length), 0);
    await optionsPage.locator("#undoBackupRestoreButton").click();
    await optionsPage.waitForFunction(() => testStorage.savedSnippets?.[0]?.id === "snippet");
    assert.equal(await optionsPage.evaluate(() => testStorage.conversations.length), 0);
    assert.deepEqual(errors, []);
    console.log("SideMind UI checks: OK (synthetic Chrome session)");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
