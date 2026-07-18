const state = { artifact: null, saveTimer: null, toastTimer: null };
const ui = Object.fromEntries([
  "artifactTitle", "refreshButton", "viewMode", "copyButton", "downloadButton", "closeButton",
  "artifactWorkspace", "codeLabel", "codeEditor", "previewFrame", "previewStatus", "previewEmpty",
  "loadError", "artifactToast"
].map((id) => [id, document.getElementById(id)]));

init();

async function init() {
  bindEvents();
  const id = new URLSearchParams(location.search).get("id");
  const { localArtifacts = [] } = await chrome.storage.local.get("localArtifacts");
  const stored = Array.isArray(localArtifacts) ? localArtifacts : [];
  state.artifact = stored.find((item) => item.id === id) || null;
  if (!state.artifact) return showLoadError("这个本地工件不存在或已被清理。请回到 SideMind 回答中重新点击工件卡片。");
  ui.artifactTitle.textContent = state.artifact.title;
  document.title = `${state.artifact.title} · SideMind 工件`;
  ui.codeLabel.textContent = `${state.artifact.label} · .${state.artifact.extension}`;
  ui.codeEditor.value = state.artifact.code;
  if (!state.artifact.previewable) ui.viewMode.value = "code";
  updateViewMode();
  renderPreview();
}

function bindEvents() {
  ui.viewMode.addEventListener("change", updateViewMode);
  ui.refreshButton.addEventListener("click", () => { renderPreview(); showToast("预览已刷新"); });
  ui.copyButton.addEventListener("click", copyArtifact);
  ui.downloadButton.addEventListener("click", downloadArtifact);
  ui.closeButton.addEventListener("click", () => window.close());
  ui.codeEditor.addEventListener("input", () => {
    if (!state.artifact) return;
    state.artifact.code = ui.codeEditor.value;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveArtifact, 350);
  });
  ui.codeEditor.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = ui.codeEditor.selectionStart;
    ui.codeEditor.setRangeText("  ", start, ui.codeEditor.selectionEnd, "end");
    ui.codeEditor.dispatchEvent(new Event("input"));
  });
}

function updateViewMode() {
  ui.artifactWorkspace.dataset.mode = ui.viewMode.value;
  if (ui.viewMode.value !== "code") renderPreview();
}

function renderPreview() {
  if (!state.artifact) return;
  const code = ui.codeEditor.value;
  const type = state.artifact.extension;
  if (type === "html") return setPreviewDocument(lockDownHtml(code));
  if (type === "svg") return setPreviewDocument(lockDownHtml(`<!doctype html><html><head><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;padding:20px;box-sizing:border-box}svg{max-width:100%;max-height:100%}</style></head><body>${code}</body></html>`));
  if (type === "md") return setPreviewDocument(markdownDocument(code));
  ui.previewFrame.hidden = true;
  ui.previewEmpty.hidden = false;
  ui.previewStatus.textContent = "代码工件";
}

function setPreviewDocument(documentText) {
  ui.previewEmpty.hidden = true;
  ui.previewFrame.hidden = false;
  ui.previewFrame.srcdoc = documentText;
  ui.previewStatus.textContent = "脚本与外部网络已禁用";
}

function lockDownHtml(code) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">`;
  if (/<head[\s>]/i.test(code)) return code.replace(/<head([^>]*)>/i, `<head$1>${policy}`);
  if (/<html[\s>]/i.test(code)) return code.replace(/<html([^>]*)>/i, `<html$1><head>${policy}</head>`);
  return `<!doctype html><html><head>${policy}<meta charset="UTF-8"></head><body>${code}</body></html>`;
}

function markdownDocument(markdown) {
  const safe = escapeHtml(markdown)
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
  return lockDownHtml(`<!doctype html><html><head><meta charset="UTF-8"><style>body{max-width:820px;margin:0 auto;padding:32px;font:16px/1.75 system-ui;color:#25222b}h1,h2,h3{line-height:1.35}code{padding:2px 5px;border-radius:5px;background:#f0edf5}</style></head><body><p>${safe}</p></body></html>`);
}

async function saveArtifact() {
  const { localArtifacts = [] } = await chrome.storage.local.get("localArtifacts");
  const stored = Array.isArray(localArtifacts) ? localArtifacts : [];
  const next = stored.map((item) => item.id === state.artifact.id
    ? { ...item, code: state.artifact.code, updatedAt: Date.now() } : item);
  await chrome.storage.local.set({ localArtifacts: next });
  if (state.artifact.previewable) renderPreview();
}

async function copyArtifact() {
  await navigator.clipboard.writeText(ui.codeEditor.value);
  showToast("工件代码已复制");
}

function downloadArtifact() {
  const artifact = state.artifact;
  if (!artifact) return;
  const blob = new Blob([`\uFEFF${ui.codeEditor.value}`], { type: `${artifact.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(artifact.title)}.${artifact.extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("工件已下载到本地");
}

function safeFilename(value) {
  return String(value || "SideMind-工件").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "SideMind-工件";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[char]);
}

function showLoadError(message) {
  ui.artifactWorkspace.hidden = true;
  ui.loadError.textContent = message;
  ui.loadError.hidden = false;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  ui.artifactToast.textContent = message;
  ui.artifactToast.hidden = false;
  state.toastTimer = setTimeout(() => { ui.artifactToast.hidden = true; }, 1900);
}
