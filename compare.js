const ui = {
  questionPanel: document.querySelector("#questionPanel"),
  questionText: document.querySelector("#questionText"),
  comparisonGrid: document.querySelector("#comparisonGrid"),
  answerCount: document.querySelector("#answerCount"),
  closeButton: document.querySelector("#closeButton"),
  emptyState: document.querySelector("#emptyState"),
  emptyMessage: document.querySelector("#emptyMessage")
};

const params = new URLSearchParams(location.search);
const conversationId = params.get("conversationId") || "";
const messageId = params.get("messageId") || "";

ui.closeButton.addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id) await chrome.tabs.remove(tab.id);
  else window.close();
});
ui.comparisonGrid.addEventListener("click", handleGridClick);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.conversations) renderComparison();
});
renderComparison();

async function renderComparison() {
  const { conversations = [] } = await chrome.storage.local.get("conversations");
  const conversation = conversations.find((item) => item.id === conversationId);
  const sourceIndex = conversation?.messages?.findIndex((item) => item.id === messageId) ?? -1;
  const source = sourceIndex >= 0 ? conversation.messages[sourceIndex] : null;
  if (!conversation || !source || source.role !== "assistant") {
    return showEmpty("对应的聊天或回答可能已经被删除，请从 SideMind 侧栏重新打开比较。");
  }

  const user = findPreviousUser(conversation.messages, sourceIndex);
  const alternatives = Array.isArray(source.comparisons) ? source.comparisons : [];
  const answers = [{
    id: source.id,
    modelName: source.modelName || "SideMind",
    modelId: source.modelId || source.modelName || "原始模型",
    content: source.content || "",
    createdAt: source.createdAt,
    primary: true
  }, ...alternatives];

  ui.emptyState.hidden = true;
  ui.questionPanel.hidden = !user;
  ui.questionText.textContent = user?.content || "";
  ui.answerCount.textContent = `${answers.length} 个模型答案`;
  ui.comparisonGrid.replaceChildren(...answers.map(createAnswerCard));
}

function createAnswerCard(answer, index) {
  const card = document.createElement("article");
  card.className = `answer-card${answer.primary ? " is-primary" : ""}`;
  card.dataset.answerIndex = String(index);

  const header = document.createElement("header");
  header.className = "answer-card-header";
  header.innerHTML = `
    <span class="model-mark">${answer.primary ? "S" : "AI"}</span>
    <div>
      <strong>${escapeHtml(answer.modelName || answer.modelId || "模型")}${answer.primary ? '<em class="primary-badge">原回答</em>' : ""}</strong>
      <small>${escapeHtml(answer.modelId || formatTime(answer.createdAt))}</small>
    </div>
    <button class="copy-answer" type="button" data-copy-answer aria-label="复制该模型回答" title="复制该模型回答">▣</button>`;

  const content = document.createElement("div");
  content.className = "answer-content";
  content.innerHTML = renderMarkdown(answer.content || "");
  card.dataset.content = answer.content || "";
  card.append(header, content);
  return card;
}

async function handleGridClick(event) {
  const button = event.target.closest("[data-copy-answer]");
  if (!button) return;
  const card = button.closest(".answer-card");
  await navigator.clipboard.writeText(card?.dataset.content || "");
  const original = button.textContent;
  button.textContent = "✓";
  setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1200);
}

function findPreviousUser(messages, sourceIndex) {
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index];
  }
  return null;
}

function showEmpty(message) {
  ui.questionPanel.hidden = true;
  ui.comparisonGrid.replaceChildren();
  ui.answerCount.textContent = "";
  ui.emptyMessage.textContent = message;
  ui.emptyState.hidden = false;
}

function renderMarkdown(markdown) {
  const codeBlocks = [];
  const safe = escapeHtml(markdown).replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, language, code) => {
    const token = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code${language ? ` data-language="${language}"` : ""}>${code.trim()}</code></pre>`);
    return token;
  });
  const output = [];
  let listType = null;
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  for (const rawLine of safe.split("\n")) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    if (/^@@CODEBLOCK\d+@@$/.test(line)) { closeList(); output.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { closeList(); output.push(`<h${heading[1].length}>${formatInline(heading[2])}</h${heading[1].length}>`); continue; }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
      output.push(`<li>${formatInline((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${formatInline(line)}</p>`);
  }
  closeList();
  return output.join("").replace(/@@CODEBLOCK(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] || "");
}

function formatInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[char]);
}

function formatTime(value) {
  const date = new Date(value || Date.now());
  return new Intl.DateTimeFormat("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }).format(date);
}
