const state = { prompts: [], category: "all", query: "", draggingId: null };
const ui = Object.fromEntries(["searchInput","newPromptButton","categoryTabs","visibleList","hiddenList","visibleCount","hiddenCount","modalBackdrop","promptDialog","promptForm","dialogTitle","closeDialogButton","cancelButton","promptId","promptName","promptContent","promptCategory","promptVisible","toast"].map((id) => [id, document.getElementById(id)]));

init();

async function init() {
  const [{ prompts, promptLibraryVersion }, exactPrompts] = await Promise.all([
    chrome.storage.local.get(["prompts", "promptLibraryVersion"]),
    loadExactPromptLibrary()
  ]);
  state.prompts = mergePromptLibrary(prompts, exactPrompts);
  if (!Array.isArray(prompts) || promptLibraryVersion !== PROMPT_LIBRARY_VERSION) {
    await chrome.storage.local.set({ prompts: state.prompts, promptLibraryVersion: PROMPT_LIBRARY_VERSION });
  }
  bindEvents();
  render();
}

function bindEvents() {
  ui.newPromptButton.addEventListener("click", () => openEditor());
  ui.searchInput.addEventListener("input", () => { state.query = ui.searchInput.value.trim().toLowerCase(); render(); });
  ui.categoryTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    state.category = button.dataset.category;
    ui.categoryTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    render();
  });
  ui.visibleList.addEventListener("click", handleListClick);
  ui.hiddenList.addEventListener("click", handleListClick);
  for (const list of [ui.visibleList, ui.hiddenList]) {
    list.addEventListener("dragstart", handleDragStart);
    list.addEventListener("dragover", handleDragOver);
    list.addEventListener("drop", handleDrop);
    list.addEventListener("dragend", clearDragState);
  }
  ui.closeDialogButton.addEventListener("click", closeEditor);
  ui.cancelButton.addEventListener("click", closeEditor);
  ui.modalBackdrop.addEventListener("click", closeEditor);
  ui.promptForm.addEventListener("submit", saveEditor);
}

function render() {
  const matches = matchingPrompts();
  renderList(ui.visibleList, matches.filter((item) => item.visible !== false));
  renderList(ui.hiddenList, matches.filter((item) => item.visible === false));
  ui.visibleCount.textContent = matches.filter((item) => item.visible !== false).length;
  ui.hiddenCount.textContent = matches.filter((item) => item.visible === false).length;
}

function renderList(container, prompts) {
  container.replaceChildren();
  if (!prompts.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "这里还没有提示词"; container.appendChild(empty); return;
  }
  prompts.forEach((prompt, index) => {
    const card = document.createElement("article");
    card.className = "prompt-card";
    card.dataset.promptId = prompt.id;
    card.innerHTML = `<span class="drag-handle" draggable="true" tabindex="0" role="button" aria-label="拖动“${escapeHtml(prompt.name)}”排序" title="拖动排序">⠿</span><div><h3>${escapeHtml(prompt.name)}</h3><p>${escapeHtml(prompt.content)}</p><small>${categoryName(prompt.category)}</small></div><div class="card-actions"><button type="button" data-action="up" title="上移" aria-label="上移"${index === 0 ? " disabled" : ""}>↑</button><button type="button" data-action="down" title="下移" aria-label="下移"${index === prompts.length - 1 ? " disabled" : ""}>↓</button><button type="button" data-action="toggle" title="${prompt.visible === false ? "显示" : "隐藏"}">${prompt.visible === false ? "显" : "隐"}</button><button type="button" data-action="edit" title="编辑">✎</button><button type="button" data-action="delete" title="删除">×</button></div>`;
    container.appendChild(card);
  });
}

function matchingPrompts() {
  return state.prompts.filter((prompt) => (state.category === "all" || prompt.category === state.category) && (!state.query || `${prompt.name} ${prompt.content}`.toLowerCase().includes(state.query)));
}

async function handleListClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = button.closest("[data-prompt-id]")?.dataset.promptId;
  const prompt = state.prompts.find((item) => item.id === id);
  if (!prompt) return;
  if (button.dataset.action === "edit") return openEditor(prompt);
  if (button.dataset.action === "up" || button.dataset.action === "down") {
    return movePrompt(id, button.dataset.action === "up" ? -1 : 1);
  }
  if (button.dataset.action === "toggle") prompt.visible = prompt.visible === false;
  if (button.dataset.action === "delete") {
    if (!window.confirm(`删除提示词“${prompt.name}”？`)) return;
    state.prompts = state.prompts.filter((item) => item.id !== id);
  }
  await persist(); render(); showToast("已更新提示词");
}

async function movePrompt(id, direction) {
  const prompt = state.prompts.find((item) => item.id === id);
  if (!prompt) return;
  const lane = matchingPrompts().filter((item) => (item.visible === false) === (prompt.visible === false));
  const laneIndex = lane.findIndex((item) => item.id === id);
  const target = lane[laneIndex + direction];
  if (!target) return;
  const sourceIndex = state.prompts.findIndex((item) => item.id === id);
  const targetIndex = state.prompts.findIndex((item) => item.id === target.id);
  [state.prompts[sourceIndex], state.prompts[targetIndex]] = [state.prompts[targetIndex], state.prompts[sourceIndex]];
  await persist();
  render();
  showToast(direction < 0 ? "提示词已上移" : "提示词已下移");
}

function handleDragStart(event) {
  const handle = event.target.closest(".drag-handle");
  const card = handle?.closest("[data-prompt-id]");
  if (!card) return event.preventDefault();
  state.draggingId = card.dataset.promptId;
  card.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggingId);
}

function handleDragOver(event) {
  if (!state.draggingId) return;
  const target = event.target.closest("[data-prompt-id]");
  const source = document.querySelector(`[data-prompt-id="${CSS.escape(state.draggingId)}"]`);
  if (!target || target === source || target.parentElement !== source?.parentElement) return;
  event.preventDefault();
  clearDropMarkers();
  const position = event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2 ? "before" : "after";
  target.classList.add(position === "before" ? "is-drop-before" : "is-drop-after");
  target.dataset.dropPosition = position;
  event.dataTransfer.dropEffect = "move";
}

async function handleDrop(event) {
  const target = event.target.closest("[data-prompt-id]");
  const sourceId = state.draggingId;
  if (!target || !sourceId || target.dataset.promptId === sourceId) return clearDragState();
  const source = target.parentElement.querySelector(`[data-prompt-id="${CSS.escape(sourceId)}"]`);
  if (!source) return clearDragState();
  event.preventDefault();
  const position = target.dataset.dropPosition || "before";
  const sourceIndex = state.prompts.findIndex((item) => item.id === sourceId);
  const [prompt] = state.prompts.splice(sourceIndex, 1);
  let targetIndex = state.prompts.findIndex((item) => item.id === target.dataset.promptId);
  if (position === "after") targetIndex += 1;
  state.prompts.splice(targetIndex, 0, prompt);
  clearDragState();
  await persist();
  render();
  showToast("提示词顺序已保存");
}

function clearDropMarkers() {
  document.querySelectorAll(".is-drop-before,.is-drop-after").forEach((card) => {
    card.classList.remove("is-drop-before", "is-drop-after");
    delete card.dataset.dropPosition;
  });
}

function clearDragState() {
  document.querySelectorAll(".is-dragging").forEach((card) => card.classList.remove("is-dragging"));
  clearDropMarkers();
  state.draggingId = null;
}

function openEditor(prompt = null) {
  ui.dialogTitle.textContent = prompt ? "编辑提示词" : "新建提示词";
  ui.promptId.value = prompt?.id || "";
  ui.promptName.value = prompt?.name || "";
  ui.promptContent.value = prompt?.content || "";
  ui.promptCategory.value = prompt?.category || "chat";
  ui.promptVisible.checked = prompt?.visible !== false;
  ui.modalBackdrop.hidden = false;
  ui.promptDialog.showModal();
  ui.promptName.focus();
}

function closeEditor() { if (ui.promptDialog.open) ui.promptDialog.close(); ui.modalBackdrop.hidden = true; }

async function saveEditor(event) {
  event.preventDefault();
  if (!ui.promptForm.reportValidity()) return;
  const id = ui.promptId.value || crypto.randomUUID();
  const next = { id, name: ui.promptName.value.trim(), content: ui.promptContent.value.trim(), category: ui.promptCategory.value, visible: ui.promptVisible.checked, updatedAt: Date.now() };
  const index = state.prompts.findIndex((item) => item.id === id);
  if (index >= 0) state.prompts[index] = next; else state.prompts.unshift(next);
  await persist(); render(); closeEditor(); showToast("提示词已保存");
}

function persist() { return chrome.storage.local.set({ prompts: state.prompts }); }
function categoryName(value) { return ({ chat:"聊天/提问", reading:"阅读", writing:"写作" })[value] || "其他"; }
function escapeHtml(value) { return String(value || "").replace(/[&<>\"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"})[char]); }
function showToast(message) { ui.toast.textContent = message; ui.toast.hidden = false; window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { ui.toast.hidden = true; }, 1800); }
