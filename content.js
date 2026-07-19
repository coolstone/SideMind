(() => {
  if (window.__SIDEMIND_LOADED__) return;
  window.__SIDEMIND_LOADED__ = true;

  let selectionText = "";
  let lastReportedSelection = "";
  let selectionNotifyTimer = null;
  let lastEditable = null;
  const toolbar = createToolbar();
  const onChatGPT = location.protocol === "https:" && location.hostname === "chatgpt.com";

  document.addEventListener("focusin", (event) => {
    if (isEditable(event.target)) lastEditable = event.target;
  }, true);

  document.addEventListener("mouseup", (event) => {
    if (toolbar.contains(event.target)) return;
    window.setTimeout(() => showToolbarForSelection(), 10);
  }, true);

  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionNotifyTimer);
    selectionNotifyTimer = window.setTimeout(reportSelectionChange, 180);
  }, true);

  document.addEventListener("mousedown", (event) => {
    if (!toolbar.contains(event.target)) hideToolbar();
  }, true);

  document.addEventListener("scroll", hideToolbar, true);
  window.addEventListener("resize", hideToolbar);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse({ ok: true, context: extractPageContext() });
      return false;
    }

    if (message?.type === "INSERT_TEXT") {
      sendResponse(insertIntoPage(message.text || ""));
      return false;
    }

    if (message?.type === "CHATGPT_FILL" && onChatGPT) {
      fillChatGPTComposer(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "CHATGPT_EXTRACT_LAST_RESPONSE" && onChatGPT) {
      sendResponse(extractLatestChatGPTResponse());
      return false;
    }

    return false;
  });

  if (onChatGPT) setupChatGPTBridge();

  function createToolbar() {
    const node = document.createElement("div");
    node.id = "sidemind-selection-toolbar";
    node.setAttribute("data-visible", "false");
    node.setAttribute("role", "toolbar");
    node.setAttribute("aria-label", "SideMind 划词工具");
    const actions = [
      ["ask", "✦ 提问"],
      ["explain", "解释"],
      ["translate", "翻译"],
      ["rewrite", "改写"]
    ];
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => openTask(action));
      node.appendChild(button);
    }
    (document.body || document.documentElement).appendChild(node);
    return node;
  }

  function showToolbarForSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (text.length < 2 || text.length > 6000 || !selection.rangeCount) {
      hideToolbar();
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    selectionText = text;
    toolbar.style.left = "0px";
    toolbar.style.top = "0px";
    toolbar.setAttribute("data-visible", "true");
    const toolbarRect = toolbar.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - toolbarRect.width - 10,
      Math.max(10, rect.left + rect.width / 2 - toolbarRect.width / 2)
    );
    const top = rect.top > toolbarRect.height + 14
      ? rect.top - toolbarRect.height - 8
      : Math.min(window.innerHeight - toolbarRect.height - 10, rect.bottom + 8);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function hideToolbar() {
    toolbar.setAttribute("data-visible", "false");
  }

  function reportSelectionChange() {
    const text = window.getSelection()?.toString().trim().slice(0, 6000) || "";
    if (text === lastReportedSelection) return;
    lastReportedSelection = text;
    chrome.runtime.sendMessage({ type: "PAGE_SELECTION_CHANGED", selection: text }).catch(() => {});
  }

  async function openTask(action) {
    hideToolbar();
    await chrome.runtime.sendMessage({
      type: "OPEN_SIDEPANEL",
      payload: { action, selection: selectionText }
    });
  }

  function extractPageContext() {
    const localFileName = location.protocol === "file:"
      ? decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) || "本地文件")
      : "";
    const title = document.title || localFileName || "无标题页面";
    const description = document.querySelector('meta[name="description"]')?.content || (localFileName ? "本地文件" : "");
    const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((node) => node.innerText.trim())
      .filter(Boolean)
      .slice(0, 40);
    const sourceSelectors = [
      "[itemprop='articleBody']", ".entry-content", ".article-content", ".post-content",
      "article", "main", "[role='main']"
    ];
    const source = sourceSelectors.map((selector) => document.querySelector(selector)).find(Boolean) || document.body;
    const clone = source.cloneNode(true);
    clone.querySelectorAll([
      "script", "style", "noscript", "svg", "canvas", "iframe", "form",
      "nav", "footer", "aside", "dialog", "[aria-hidden='true']",
      "#sidemind-selection-toolbar", "#sidemind-chatgpt-sync", "#sidemind-chatgpt-notice"
    ].join(",")).forEach((node) => node.remove());
    const domText = (clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const structuredText = extractStructuredArticleText();
    const imageNotes = [...source.querySelectorAll("img[alt]")]
      .map((image) => image.alt.trim())
      .filter((alt) => alt.length > 8)
      .filter((alt, index, list) => list.indexOf(alt) === index)
      .slice(0, 12);
    const parts = [domText];
    if (structuredText && !domText.includes(structuredText.slice(0, 160))) {
      parts.push(`结构化文章正文：\n${structuredText}`);
    }
    if (imageNotes.length) parts.push(`页面图片说明：\n${imageNotes.join("\n")}`);
    const text = parts.filter(Boolean).join("\n\n").slice(0, 24000);

    return {
      title,
      description,
      url: canonical,
      headings,
      text,
      selection: window.getSelection()?.toString().trim().slice(0, 6000) || "",
      capturedAt: new Date().toISOString()
    };
  }

  function extractStructuredArticleText() {
    const values = [];
    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        collectArticleText(JSON.parse(script.textContent || ""), values);
      } catch {
        // 忽略页面中格式不完整的结构化数据。
      }
    }
    return values
      .map((value) => String(value).replace(/\s+/g, " ").trim())
      .filter((value) => value.length > 80)
      .sort((a, b) => b.length - a.length)[0] || "";
  }

  function collectArticleText(value, output) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) collectArticleText(item, output);
      return;
    }
    if (typeof value !== "object") return;
    if (typeof value.articleBody === "string") output.push(value.articleBody);
    for (const child of Object.values(value)) collectArticleText(child, output);
  }

  function insertIntoPage(text) {
    const target = lastEditable || document.activeElement;
    if (!isEditable(target)) {
      return { ok: false, error: "请先在网页中点击一个输入框，再点击“写入网页”" };
    }
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.setRangeText(text, start, end, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
      if (!target.contains(range.commonAncestorContainer)) {
        range.selectNodeContents(target);
        range.collapse(false);
      }
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return { ok: true };
  }

  function isEditable(target) {
    return target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && /^(text|search|email|url|tel|password)?$/.test(target.type)) ||
      target?.isContentEditable;
  }

  function setupChatGPTBridge() {
    injectChatGPTSyncButton();
    window.setTimeout(async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "CHATGPT_PAGE_READY" });
        const result = response?.result;
        if (result?.delivered) {
          showChatGPTNotice(result.imageAttached
            ? "SideMind 已填入提示词并附加截图，请检查后手动发送"
            : "SideMind 已填入提示词，请检查后手动发送");
        } else if (result?.error) {
          showChatGPTNotice(result.error, true);
        }
      } catch {
        // 没有待交接任务时保持静默。
      }
    }, 800);
  }

  async function fillChatGPTComposer(payload) {
    const composer = await waitForChatGPTComposer();
    if (!composer) return { ok: false, error: "没有找到 ChatGPT 输入框，请等待页面加载后重试" };
    const existing = readEditableText(composer).trim();
    if (existing) {
      return { ok: false, error: "ChatGPT 输入框里已有草稿，为避免覆盖未自动填入" };
    }

    setEditableText(composer, payload?.prompt || "");
    const inserted = readEditableText(composer).trim().length > 0;
    if (!inserted) return { ok: false, error: "提示词未能写入 ChatGPT 输入框" };

    let imageAttached = false;
    const images = payload?.imageDataUrls || (payload?.imageDataUrl ? [payload.imageDataUrl] : []);
    if (images.length) {
      try {
        imageAttached = await attachImagesToChatGPT(images);
      } catch {
        imageAttached = false;
      }
    }
    composer.focus();
    showChatGPTNotice(imageAttached
      ? "提示词和截图已就绪，请确认内容后手动发送"
      : images.length
        ? "提示词已填入；截图未能自动附加，可在 ChatGPT 中手动上传"
        : "提示词已就绪，请确认内容后手动发送");
    return { ok: true, imageAttached };
  }

  async function waitForChatGPTComposer() {
    const selectors = [
      "#prompt-textarea",
      "textarea[data-testid='prompt-textarea']",
      "form textarea",
      "form [contenteditable='true']"
    ];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node && isEditable(node)) return node;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return null;
  }

  function readEditableText(node) {
    return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement
      ? node.value
      : node.innerText || node.textContent || "";
  }

  function setEditableText(node, text) {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, text);
      else node.value = text;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || !readEditableText(node).trim()) {
      node.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      node.appendChild(paragraph);
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  async function attachImagesToChatGPT(dataUrls) {
    const inputs = [...document.querySelectorAll("input[type='file']")];
    const input = inputs.find((node) => /image|png|jpeg|jpg/i.test(node.accept || "")) || inputs[0];
    if (!input) return false;
    const transfer = new DataTransfer();
    for (let index = 0; index < dataUrls.length; index += 1) {
      const blob = await (await fetch(dataUrls[index])).blob();
      const extension = blob.type === "image/png" ? "png" : "jpg";
      transfer.items.add(new File([blob], `sidemind-${index + 1}.${extension}`, { type: blob.type || "image/jpeg" }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return transfer.files.length > 0;
  }

  function extractLatestChatGPTResponse() {
    const responses = [...document.querySelectorAll("[data-message-author-role='assistant']")]
      .filter((item) => item.isConnected && item.getClientRects().length && !item.closest("[aria-hidden='true']"));
    const node = responses[responses.length - 1];
    const content = node?.querySelector(".markdown, [data-message-content-part]") || node;
    const text = content?.innerText?.trim() || "";
    if (!text) return { ok: false, error: "当前页面还没有可同步的 ChatGPT 回答" };
    return { ok: true, text };
  }

  function injectChatGPTSyncButton() {
    if (!onChatGPT) return;
    if (document.getElementById("sidemind-chatgpt-sync")) return;
    const button = document.createElement("button");
    button.id = "sidemind-chatgpt-sync";
    button.type = "button";
    button.textContent = "✦ 同步最新回答到 SideMind";
    button.addEventListener("click", async () => {
      const result = extractLatestChatGPTResponse();
      if (!result.ok) return showChatGPTNotice(result.error, true);
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHATGPT_IMPORT_RESPONSE",
          text: result.text
        });
        const message = response?.ok
          ? response.panelOpened === false
            ? "回答已保存；请点击 SideMind 扩展图标打开侧栏"
            : "最新回答已同步到 SideMind"
          : response?.error || "同步失败";
        showChatGPTNotice(message, !response?.ok);
      } finally {
        button.disabled = false;
      }
    });
    document.documentElement.appendChild(button);
  }

  function showChatGPTNotice(message, isError = false) {
    let notice = document.getElementById("sidemind-chatgpt-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "sidemind-chatgpt-notice";
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    notice.dataset.error = String(isError);
    notice.dataset.visible = "true";
    window.clearTimeout(notice.__hideTimer);
    notice.__hideTimer = window.setTimeout(() => { notice.dataset.visible = "false"; }, 4200);
  }
})();
