(function registerHistoryTransfer(global) {
  function parseDate(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (!match) return 0;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const timestamp = new Date(year, month - 1, day, hour, minute, second).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function metadataValue(block, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return block.match(new RegExp(`^- ${escaped}：(.+)$`, "m"))?.[1]?.trim() || "";
  }

  function makeId(prefix, index) {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function parseMessages(block, conversationIndex) {
    const headerPattern = /^###[ \t]+(用户|SideMind)(?:[ \t]+·[ \t]+(.+?))?[ \t]+·[ \t]+(\d{4}\/\d{1,2}\/\d{1,2}[ \t]+\d{1,2}:\d{2}:\d{2}|未知)[ \t]*$/gm;
    const headers = [];
    let match;
    while ((match = headerPattern.exec(block))) {
      headers.push({ index: match.index, end: headerPattern.lastIndex, roleLabel: match[1], modelName: match[2] || "", dateLabel: match[3] });
    }

    return headers.map((header, index) => {
      const end = headers[index + 1]?.index ?? block.length;
      let content = block.slice(header.end, end).replace(/^\n+/, "").replace(/\n+$/, "");
      if (index === headers.length - 1) content = content.replace(/\n---\s*$/, "").replace(/\n+$/, "");
      const attachmentPattern = /\n*>\s*(?:此轮包含图片或附件；附件文件本身未保存在聊天历史中。|此轮包含 \d+ 张保存在浏览器本地的图片预览；Markdown 导出不内嵌图片数据。|此轮包含 \d+ 张图片；本地预览已因空间预算移除。|此轮包含附件；附件文件本身未写入 Markdown 导出。)\s*$/;
      let hadAttachments = false;
      while (attachmentPattern.test(content)) {
        hadAttachments = true;
        content = content.replace(attachmentPattern, "").trim();
      }
      if (content === "（空消息）") content = "";
      return {
        id: makeId("message", `${conversationIndex}-${index}`),
        role: header.roleLabel === "SideMind" ? "assistant" : "user",
        content,
        createdAt: parseDate(header.dateLabel) || Date.now(),
        ...(header.roleLabel === "SideMind" && header.modelName ? { modelName: header.modelName } : {}),
        ...(hadAttachments ? { hadAttachments: true } : {})
      };
    });
  }

  function parseHistoryMarkdown(source) {
    const text = String(source || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const spaceName = text.match(/^#\s+SideMind\s+聊天历史：(.+)$/m)?.[1]?.trim() || "";
    if (!spaceName) throw new Error("这不是 SideMind 导出的聊天历史 Markdown 文件");

    const headerPattern = /^##[ \t]+\d+\.[ \t]+(.+?)[ \t]*$/gm;
    const headers = [];
    let match;
    while ((match = headerPattern.exec(text))) {
      if (!text.slice(headerPattern.lastIndex).startsWith("\n\n- 创建时间：")) continue;
      headers.push({ index: match.index, title: match[1].trim() });
    }
    if (!headers.length) throw new Error("文件中没有可导入的 SideMind 会话");

    const conversations = headers.map((header, index) => {
      const end = headers[index + 1]?.index ?? text.length;
      const block = text.slice(header.index, end);
      const messages = parseMessages(block, index);
      if (!messages.length) return null;
      const createdAt = parseDate(metadataValue(block, "创建时间")) || messages[0].createdAt;
      const updatedAt = parseDate(metadataValue(block, "更新时间")) || messages.at(-1).createdAt || createdAt;
      const pageTitle = metadataValue(block, "关联网页");
      const url = metadataValue(block, "网页地址");
      return {
        id: makeId("conversation", index),
        title: header.title || "导入的对话",
        titleCustomized: true,
        pageTitle,
        url,
        createdAt,
        updatedAt,
        messages,
        importKey: [header.title, createdAt, url, messages.length].join("|")
      };
    }).filter(Boolean);

    if (!conversations.length) throw new Error("文件中没有可导入的消息");
    return { spaceName, conversations };
  }

  global.SideMindHistory = { parseHistoryMarkdown, parseDate };
})(globalThis);
