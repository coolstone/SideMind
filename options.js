const DEFAULTS = {
  connectionMode: "api", provider: "openai", apiMode: "responses",
  baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra",
  apiKey: "", maxOutputTokens: 1800, language: "zh-CN", responseLanguage: "简体中文", startupBehavior: "restore_last",
  activeProfileId: "default", modelProfiles: [], modelProfileLibraryVersion: 0
};

const MODEL_PROFILE_LIBRARY_VERSION = 1;
const BUILT_IN_MODEL_PROFILES = [
  { id: "builtin-openai", name: "OpenAI · GPT-5.6 Terra", provider: "openai", apiMode: "responses", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-5.6-terra", maxOutputTokens: 16000 },
  { id: "builtin-deepseek", name: "DeepSeek · V4 Flash", provider: "deepseek", apiMode: "chat", baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-v4-flash", maxOutputTokens: 16000 }
];

const PROVIDER_PRESETS = {
  openai: { apiMode: "responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra", maxLimit: 128000, tokenHint: "GPT-5.6 最高可配置 128,000；日常网页总结建议使用 4,000—16,000。" },
  deepseek: { apiMode: "chat", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", maxLimit: 384000, tokenHint: "DeepSeek V4 当前最大输出为 384,000，但官方 API 仅支持文本输入；图片请切换到视觉模型或 ChatGPT 网页模式。" },
  openrouter: { apiMode: "chat", baseUrl: "https://openrouter.ai/api/v1", model: "~openai/gpt-latest", maxLimit: null, tokenHint: "OpenRouter 的输出上限由所选路由模型决定，请按对应模型能力设置。" },
  compatible: { apiMode: "chat", baseUrl: "", model: "", maxLimit: null, tokenHint: "请根据兼容服务的模型文档填写输出上限。" }
};

const state = { profiles: [], activeProfileId: "default", previousSettings: {} };
const form = document.getElementById("settingsForm");
const fields = {
  connectionMode: document.getElementById("connectionMode"), responseLanguage: document.getElementById("responseLanguage"), startupBehavior: document.getElementById("startupBehavior"), profileSelect: document.getElementById("profileSelect"), profileName: document.getElementById("profileName"),
  provider: document.getElementById("provider"), apiMode: document.getElementById("apiMode"), baseUrl: document.getElementById("baseUrl"),
  apiKey: document.getElementById("apiKey"), model: document.getElementById("model"), maxOutputTokens: document.getElementById("maxOutputTokens")
};
const statusText = document.getElementById("statusText");
const testButton = document.getElementById("testButton");
const toggleKeyButton = document.getElementById("toggleKeyButton");
const newProfileButton = document.getElementById("newProfileButton");
const deleteProfileButton = document.getElementById("deleteProfileButton");
const connectionModeHint = document.getElementById("connectionModeHint");
const tokenHint = document.getElementById("tokenHint");
const securityTitle = document.getElementById("securityTitle");
const securityDescription = document.getElementById("securityDescription");
const backupInstallNotice = document.getElementById("backupInstallNotice");
const dismissBackupNoticeButton = document.getElementById("dismissBackupNoticeButton");
const includeApiKeysInBackup = document.getElementById("includeApiKeysInBackup");
const backupFileInput = document.getElementById("backupFileInput");
const importBackupButton = document.getElementById("importBackupButton");
const exportBackupButton = document.getElementById("exportBackupButton");
const backupStatus = document.getElementById("backupStatus");

const BACKUP_FORMAT = "sidemind-local-backup";
const BACKUP_VERSION = 1;
const BACKUP_STORAGE_KEYS = ["settings", "prompts", "promptLibraryVersion", "spaces", "conversations", "uiPreferences", "localArtifacts"];

init();

async function init() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const values = migrateSettings({ ...DEFAULTS, ...settings });
  state.previousSettings = values;
  state.profiles = values.modelProfiles;
  state.activeProfileId = values.activeProfileId;
  fields.connectionMode.value = values.connectionMode;
  fields.responseLanguage.value = values.responseLanguage || DEFAULTS.responseLanguage;
  fields.startupBehavior.value = values.startupBehavior === "new_chat" ? "new_chat" : "restore_last";
  renderProfileSelect();
  loadProfile(state.activeProfileId);
  updateModeSections();
  const { backupReminderPending = false } = await chrome.storage.local.get("backupReminderPending");
  backupInstallNotice.hidden = !backupReminderPending;
  if (!settings.modelProfiles?.length || Number(settings.modelProfileLibraryVersion || 0) < MODEL_PROFILE_LIBRARY_VERSION) {
    await chrome.storage.local.set({ settings: values });
  }
}

function migrateSettings(settings) {
  if (Array.isArray(settings.modelProfiles) && settings.modelProfiles.length) {
    const profiles = mergeBuiltInProfiles(settings.modelProfiles, settings.modelProfileLibraryVersion);
    const active = profiles.find((item) => item.id === settings.activeProfileId) || profiles[0];
    return { ...settings, ...active, activeProfileId: active.id, modelProfiles: profiles, modelProfileLibraryVersion: MODEL_PROFILE_LIBRARY_VERSION };
  }
  const profile = profileFromValues(settings.activeProfileId || "default", `${providerLabel(settings.provider)} · ${settings.model || "默认模型"}`, settings);
  const profiles = mergeBuiltInProfiles([profile], 0);
  return { ...settings, activeProfileId: profile.id, modelProfiles: profiles, modelProfileLibraryVersion: MODEL_PROFILE_LIBRARY_VERSION };
}

function mergeBuiltInProfiles(profiles, libraryVersion) {
  const next = profiles.map((profile) => ({ ...profile }));
  if (Number(libraryVersion || 0) >= MODEL_PROFILE_LIBRARY_VERSION) return next;
  for (const builtIn of BUILT_IN_MODEL_PROFILES) {
    if (!next.some((profile) => profile.provider === builtIn.provider)) next.push({ ...builtIn });
  }
  return next;
}

function profileFromValues(id, name, values) {
  return { id, name, provider: values.provider, apiMode: values.apiMode, baseUrl: values.baseUrl, apiKey: values.apiKey, model: values.model, maxOutputTokens: Number(values.maxOutputTokens) || DEFAULTS.maxOutputTokens };
}

function renderProfileSelect() {
  fields.profileSelect.replaceChildren(...state.profiles.map((profile) => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name || profile.model; return option;
  }));
  fields.profileSelect.value = state.activeProfileId;
  deleteProfileButton.disabled = state.profiles.length <= 1;
}

function loadProfile(profileId) {
  const profile = state.profiles.find((item) => item.id === profileId) || state.profiles[0];
  if (!profile) return;
  state.activeProfileId = profile.id;
  fields.profileSelect.value = profile.id;
  for (const key of ["profileName","provider","apiMode","baseUrl","apiKey","model","maxOutputTokens"]) {
    fields[key].value = key === "profileName" ? profile.name : profile[key];
  }
  updateProviderHint();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  await saveSettings();
  setStatus(fields.connectionMode.value === "chatgpt_web" ? "网页交接模式已保存。" : "模型配置已保存，可在侧栏直接切换。", "success");
});

testButton.addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  setBusy(true); setStatus("正在连接模型服务…");
  try {
    await saveSettings();
    const response = await chrome.runtime.sendMessage({ type: "AI_REQUEST", payload: { instructions: "你是连接测试助手。严格按用户要求输出。", prompt: "只回复四个字：连接成功", imageDataUrls: [], reasoningEffort: "none" } });
    if (!response?.ok) throw new Error(response?.error || "连接失败");
    setStatus(`连接正常：${response.result.text.trim()}`, "success");
  } catch (error) { setStatus(error.message, "error"); } finally { setBusy(false); }
});

toggleKeyButton.addEventListener("click", () => { const showing = fields.apiKey.type === "text"; fields.apiKey.type = showing ? "password" : "text"; toggleKeyButton.textContent = showing ? "显示" : "隐藏"; });
fields.connectionMode.addEventListener("change", updateModeSections);
fields.profileSelect.addEventListener("change", () => { snapshotCurrentProfile(); loadProfile(fields.profileSelect.value); });
fields.provider.addEventListener("change", () => applyProviderPreset(fields.provider.value));
newProfileButton.addEventListener("click", createProfile);
deleteProfileButton.addEventListener("click", deleteProfile);
exportBackupButton.addEventListener("click", exportLocalBackup);
importBackupButton.addEventListener("click", () => backupFileInput.click());
backupFileInput.addEventListener("change", importLocalBackup);
dismissBackupNoticeButton.addEventListener("click", dismissBackupNotice);

function createProfile() {
  snapshotCurrentProfile();
  const preset = PROVIDER_PRESETS.openai;
  const profile = profileFromValues(crypto.randomUUID(), `新模型 ${state.profiles.length + 1}`, { ...DEFAULTS, ...preset, apiKey: "" });
  state.profiles.push(profile); state.activeProfileId = profile.id; renderProfileSelect(); loadProfile(profile.id); fields.profileName.select(); setStatus("填写新模型配置后保存。", "");
}

async function deleteProfile() {
  if (state.profiles.length <= 1) return;
  const active = state.profiles.find((item) => item.id === state.activeProfileId);
  if (!window.confirm(`删除模型配置“${active?.name || "当前配置"}”？`)) return;
  state.profiles = state.profiles.filter((item) => item.id !== state.activeProfileId);
  state.activeProfileId = state.profiles[0].id; renderProfileSelect(); loadProfile(state.activeProfileId); await saveSettings(); setStatus("模型配置已删除。", "success");
}

function updateModeSections() {
  const webMode = fields.connectionMode.value === "chatgpt_web";
  for (const node of document.querySelectorAll(".api-only")) node.hidden = webMode;
  for (const field of [fields.profileSelect,fields.profileName,fields.provider,fields.apiMode,fields.baseUrl,fields.apiKey,fields.model,fields.maxOutputTokens]) field.disabled = webMode;
  fields.profileName.required = !webMode; fields.baseUrl.required = !webMode; fields.apiKey.required = !webMode; fields.model.required = !webMode; fields.maxOutputTokens.required = !webMode;
  document.querySelector(".settings-card:not(.api-only)")?.classList.toggle("is-web-mode", webMode);
  connectionModeHint.textContent = webMode ? "把网页上下文写入正常的 chatgpt.com 输入框，由你检查并手动发送；之后可同步页面上可见的最新回答。" : "直接请求你配置的模型服务，回答会自动返回 SideMind。";
  securityTitle.textContent = webMode ? "ChatGPT 网页交接的安全边界" : "API Key 模式的安全边界";
  securityDescription.textContent = webMode ? "只读取当前 ChatGPT 页面可见的回答 DOM；不读取 Cookie，不调用私有接口，不拦截网络响应，也不会自动点击发送。" : "每个模型配置的 API Key 保存在 chrome.storage.local，并限制为扩展受信任页面可读。正式发布时仍建议使用服务端代理。";
  setStatus("");
}

function applyProviderPreset(provider) {
  const preset = PROVIDER_PRESETS[provider]; if (!preset) return;
  fields.apiMode.value = preset.apiMode; fields.baseUrl.value = preset.baseUrl; fields.model.value = preset.model; fields.apiKey.value = "";
  if (!fields.profileName.value || /^新模型/.test(fields.profileName.value)) fields.profileName.value = `${providerLabel(provider)} · ${preset.model || "自定义"}`;
  updateProviderHint(); setStatus("服务商已切换，请填写该服务商对应的 API Key。", "");
}

function updateProviderHint() { const preset = PROVIDER_PRESETS[fields.provider.value] || PROVIDER_PRESETS.compatible; tokenHint.textContent = preset.tokenHint; if (preset.maxLimit) fields.maxOutputTokens.max = String(preset.maxLimit); else fields.maxOutputTokens.removeAttribute("max"); }

async function saveSettings() {
  const webMode = fields.connectionMode.value === "chatgpt_web";
  if (!webMode) snapshotCurrentProfile();
  const active = state.profiles.find((item) => item.id === state.activeProfileId) || state.profiles[0];
  const responseLanguage = fields.responseLanguage.value || DEFAULTS.responseLanguage;
  const startupBehavior = fields.startupBehavior.value === "new_chat" ? "new_chat" : "restore_last";
  const settings = { ...DEFAULTS, ...state.previousSettings, ...active, connectionMode:webMode ? "chatgpt_web" : "api", activeProfileId:active.id, modelProfiles:state.profiles, responseLanguage, language:responseLanguageCode(responseLanguage), startupBehavior };
  state.previousSettings = settings; await chrome.storage.local.set({ settings }); renderProfileSelect(); return settings;
}

function snapshotCurrentProfile() {
  if (!state.activeProfileId || !fields.profileName.value) return;
  const nextProfile = profileFromValues(state.activeProfileId, fields.profileName.value.trim(), { provider:fields.provider.value, apiMode:fields.apiMode.value, baseUrl:fields.baseUrl.value.trim().replace(/\/+$/, ""), apiKey:fields.apiKey.value.trim(), model:fields.model.value.trim(), maxOutputTokens:Number(fields.maxOutputTokens.value) || DEFAULTS.maxOutputTokens });
  const index = state.profiles.findIndex((item) => item.id === state.activeProfileId);
  if (index >= 0) state.profiles[index] = nextProfile; else state.profiles.push(nextProfile);
}

function providerLabel(value) { return ({openai:"OpenAI",deepseek:"DeepSeek",openrouter:"OpenRouter",compatible:"兼容服务"})[value] || value; }
function responseLanguageCode(value) { return ({"简体中文":"zh-CN","繁體中文":"zh-TW",English:"en",日本語:"ja",한국어:"ko",Español:"es",Français:"fr",Deutsch:"de"})[value] || "zh-CN"; }
function setStatus(message, type = "") { statusText.textContent = message; statusText.className = type; }
function setBusy(busy) { testButton.disabled = busy; form.querySelector("button[type='submit']").disabled = busy; }

async function exportLocalBackup() {
  const includeApiKeys = includeApiKeysInBackup.checked;
  if (includeApiKeys && !window.confirm("备份文件将以明文包含 API Key。确定继续导出吗？")) return;
  try {
    const stored = await chrome.storage.local.get(BACKUP_STORAGE_KEYS);
    const data = structuredClone(stored);
    if (!includeApiKeys && data.settings) data.settings = removeApiKeys(data.settings);
    const payload = {
      format: BACKUP_FORMAT,
      backupVersion: BACKUP_VERSION,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      includesApiKeys: includeApiKeys,
      data
    };
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const label = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    downloadBackupFile(`SideMind-本地备份-${label}.json`, JSON.stringify(payload, null, 2));
    setBackupStatus(includeApiKeys ? "完整备份已导出，请像保管密码一样保管该文件。" : "本地备份已导出；API Key 未包含。", "success");
    await dismissBackupNotice();
  } catch (error) {
    setBackupStatus(error.message || "本地备份导出失败", "error");
  }
}

async function importLocalBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return setBackupStatus("备份文件不能超过 20MB", "error");
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== BACKUP_FORMAT || !payload.data || typeof payload.data !== "object") {
      throw new Error("这不是有效的 SideMind 本地备份文件");
    }
    if (!window.confirm("恢复备份会覆盖当前模型配置、提示词、聊天历史和运行偏好。确定继续吗？")) return;
    const current = await chrome.storage.local.get("settings");
    const data = Object.fromEntries(BACKUP_STORAGE_KEYS.filter((key) => key in payload.data).map((key) => [key, payload.data[key]]));
    if (!payload.includesApiKeys && data.settings) data.settings = preserveCurrentApiKeys(data.settings, current.settings || {});
    await chrome.storage.local.set({ ...data, backupReminderPending: false });
    backupInstallNotice.hidden = true;
    setBackupStatus(`备份已恢复（导出版本 ${payload.extensionVersion || "未知"}），正在刷新设置…`, "success");
    setTimeout(() => location.reload(), 700);
  } catch (error) {
    setBackupStatus(error.message || "本地备份恢复失败", "error");
  }
}

function removeApiKeys(settings) {
  return {
    ...settings,
    apiKey: "",
    modelProfiles: Array.isArray(settings.modelProfiles)
      ? settings.modelProfiles.map((profile) => ({ ...profile, apiKey: "" }))
      : []
  };
}

function preserveCurrentApiKeys(imported, current) {
  const currentProfiles = Array.isArray(current.modelProfiles) ? current.modelProfiles : [];
  const profiles = Array.isArray(imported.modelProfiles) ? imported.modelProfiles.map((profile) => {
    const matched = currentProfiles.find((item) => item.id === profile.id)
      || currentProfiles.find((item) => item.provider === profile.provider && item.model === profile.model);
    return { ...profile, apiKey: matched?.apiKey || "" };
  }) : [];
  const active = profiles.find((profile) => profile.id === imported.activeProfileId);
  return { ...imported, apiKey: active?.apiKey || current.apiKey || "", modelProfiles: profiles };
}

function downloadBackupFile(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function dismissBackupNotice() {
  backupInstallNotice.hidden = true;
  await chrome.storage.local.set({ backupReminderPending: false });
}

function setBackupStatus(message, type = "") {
  backupStatus.textContent = message;
  backupStatus.className = `backup-status${type ? ` ${type}` : ""}`;
}
