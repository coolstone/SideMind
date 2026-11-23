globalThis.SideMindSnippets = (() => {
  async function save(snippet) {
    const operation = async () => {
      const { savedSnippets = [] } = await chrome.storage.local.get("savedSnippets");
      if (savedSnippets.some((item) => item.conversationId === snippet.conversationId && item.messageId === snippet.messageId && item.content === snippet.content)) return;
      await chrome.storage.local.set({ savedSnippets: [{ id: crypto.randomUUID(), createdAt: Date.now(), ...snippet }, ...savedSnippets] });
    };
    return navigator.locks ? navigator.locks.request("sidemind-snippets", operation) : operation();
  }
  function markdown(items) {
    return items.map((item) => `## ${item.title || "收藏片段"}\n\n${item.content}\n\n来源：${item.source || "对话"}\n\n收藏于 ${new Date(item.createdAt).toLocaleString()}\n`).join("\n---\n\n");
  }
  async function open({ spaceId, onNavigate }) {
    const dialog = document.createElement("dialog");
    dialog.className = "snippet-dialog";
    dialog.innerHTML = '<h2>收藏片段</h2><input type="search" aria-label="搜索收藏片段" placeholder="搜索内容、标题或来源"><div class="snippet-list"></div><div class="snippet-footer"><button type="button" data-export>导出 Markdown</button><button type="button" data-close>关闭</button></div>';
    document.body.appendChild(dialog);
    const search = dialog.querySelector("input");
    const list = dialog.querySelector(".snippet-list");
    let items = [], filtered = [], limit = 30;
    function render() {
      const query = search.value.toLowerCase();
      filtered = items.filter((item) => `${item.title} ${item.content} ${item.source}`.toLowerCase().includes(query));
      list.replaceChildren();
      if (!filtered.length) list.textContent = "暂无匹配片段。在回答下方点击收藏，可保存整条回答或选中的文字。";
      for (const item of filtered.slice(0, limit)) {
        const row = document.createElement("article");
        const title = document.createElement("strong"); title.textContent = item.title || "收藏片段";
        const content = document.createElement("p"); content.textContent = item.content;
        const source = document.createElement("small"); source.textContent = `${item.source || "对话"} · ${new Date(item.createdAt).toLocaleString()}`;
        const jump = document.createElement("button"); jump.type = "button"; jump.textContent = "返回原对话";
        jump.onclick = async () => { if (await onNavigate(item)) dialog.close(); };
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除片段";
        remove.onclick = async () => {
          if (!confirm("删除这条收藏片段？原对话不会删除。")) return;
          try {
            const operation = async () => {
              const { savedSnippets = [] } = await chrome.storage.local.get("savedSnippets");
              await chrome.storage.local.set({ savedSnippets: savedSnippets.filter((entry) => entry.id !== item.id) });
            };
            if (navigator.locks) await navigator.locks.request("sidemind-snippets", operation); else await operation();
            items = items.filter((entry) => entry.id !== item.id); render();
          } catch (error) { alert(`删除失败：${error.message}`); }
        };
        row.append(title, content, source, jump, remove); list.appendChild(row);
      }
      if (filtered.length > limit) {
        const more = document.createElement("button"); more.type = "button"; more.textContent = "加载更多";
        more.onclick = () => { limit += 30; render(); }; list.appendChild(more);
      }
    }
    search.oninput = () => { limit = 30; render(); };
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.querySelector("[data-export]").onclick = () => {
      const url = URL.createObjectURL(new Blob([markdown(filtered)], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = "SideMind-收藏片段.md"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };
    const { savedSnippets = [] } = await chrome.storage.local.get("savedSnippets");
    items = savedSnippets.filter((item) => item.spaceId === spaceId);
    render(); dialog.showModal(); search.focus();
  }
  return { save, open, markdown };
})();
