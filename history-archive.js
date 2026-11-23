/* Offline Markdown archive. All paths are relative to the root Markdown file. */
globalThis.SideMindHistoryArchive = {
  async build(space, conversations) {
    const zip = new JSZip();
    const lines = ["# SideMind 聊天历史 · " + space.name, ""];
    const paths = new Map();
    const remotePaths = new Map();
    const imagePattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!\[([^\]\n]*)\]\\?\((https\\?:\/\/[^\s)\\]+)\\?\)/gi;
    let downloadRemote;
    async function localizeImages(content) {
      let output = "", offset = 0;
      for (const match of content.matchAll(imagePattern)) {
        if (!match[2]) continue;
        if (downloadRemote === undefined) downloadRemote = window.confirm("聊天中含有网络图片。下载这些图片以便离线查看？取消将保留原链接。");
        if (!downloadRemote) return content;
        const url = match[2].replace("\\:", ":");
        if (!remotePaths.has(url)) {
          let path = "";
          try {
            const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10000) });
            const type = response.headers.get("content-type")?.split(";")[0];
            if (!response.ok || !/^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(type)) throw Error();
            const bytes = await response.arrayBuffer();
            path = "assets/web-" + (remotePaths.size + 1) + "." + type.slice(6);
            zip.file(path, bytes);
          } catch { /* Keep source URL when a site disallows downloading. */ }
          remotePaths.set(url, path);
        }
        output += content.slice(offset, match.index);
        output += remotePaths.get(url) ? "![" + match[1] + "](" + remotePaths.get(url) + ")" : match[0] + "（网络图片未归档）";
        offset = match.index + match[0].length;
      }
      return output + content.slice(offset);
    }
    const pdfs = new Map();
    for (const chat of conversations) {
      for (const message of chat.messages || []) {
        for (const file of message.attachments || []) {
          if (file.pdfId && file.originalDataUrl) pdfs.set(file.pdfId, file.originalDataUrl);
        }
      }
    }
    function appendFile(file) {
      const data = file.originalDataUrl || pdfs.get(file.pdfId) || file.dataUrl;
      const name = (file.name || "附件").replace(/[\r\n]/g, " ");
      if (!data) {
        lines.push("> " + name + "（历史中没有可导出的文件数据）", "");
        return;
      }
      const comma = data.indexOf(",");
      if (!/^data:[^,]*;base64$/i.test(data.slice(0, comma))) {
        lines.push("> " + name + "（附件数据格式无法导出）", "");
        return;
      }
      let path = paths.get(data);
      if (!path) {
        let basename = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 90);
        const imageType = /^data:image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)[;,]/i.exec(data)?.[1];
        if (imageType) basename = basename.replace(/\.[a-z0-9]{1,6}$/i, "") + "." + (imageType === "svg+xml" ? "svg" : imageType);
        path = "assets/" + (paths.size + 1) + "-" + basename;
        zip.file(path, data.slice(comma + 1), { base64: true });
        paths.set(data, path);
      }
      const label = name.replace(/[\\[\]]/g, "\\$&");
      lines.push((file.kind === "image" ? "!" : "") + "[" + label + "](" + path + ")", "");
    }
    for (const chat of conversations) {
      lines.push("## " + (chat.title || "新对话"), "");
      if (chat.url) lines.push("来源：" + chat.url, "");
      for (const message of chat.messages || []) {
        for (const part of [message, ...(message.comparisons || [])]) {
          lines.push("### " + (message.role === "user" ? "用户" : part.modelName || "SideMind"), "", await localizeImages(part.content || ""), "");
          for (const file of part.attachments || []) appendFile(file);
        }
        if (message.role === "user" && message.pdfContext && !message.attachments?.some(a => a.pdfId)) {
          appendFile({ name: message.pdfContext.name, pdfId: message.pdfContext.id });
        }
      }
    }
    zip.file("聊天记录.md", lines.join("\n"));
    return zip.generateAsync({ type: "blob" });
  }
};
