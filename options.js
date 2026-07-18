const DEFAULTS = {
  connectionMode: "api", provider: "openai", apiMode: "responses",
  baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra",
  apiKey: "", maxOutputTokens: 1800, language: "zh-CN", responseLanguage: "简体中文",
  activeProfileId: "default", modelProfiles: []
};

const PROVIDER_PRESETS = {
  openai: { apiMode: "responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra", maxLimit: 128000, tokenHint: "GPT-5.6 最高可配置 128,000；日常网页总结建议使用 4,000—16,000。" },
  deepseek: { apiMode: "chat", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", maxLimit: 384000, tokenHint: "DeepSeek V4 当前最大输出为 384,000；通用任务可先使用 4,000—16,000。" },
  openrouter: { apiMode: "chat", baseUrl: "https://openrouter.ai/api/v1", model: "~openai/gpt-latest", maxLimit: null, tokenHint: "OpenRouter 的输出上限由所选路由模型决定，请按对应模型能力设置。" },
  compatible: { apiMode: "chat", baseUrl: "", model: "", maxLimit: null, tokenHint: "请根据兼容服务的模型文档填写输出上限。" }
};

const state = { profiles: [], activeProfileId: "default", previousSettings: {} };
const form = document.getElementById("settingsForm");
const fields = {
  connectionMode: document.getElementById("connectionMode"), responseLanguage: document.getElementById("responseLanguage"), profileSelect: document.getElementById("profileSelect"), profileName: document.getElementById("profileName"),
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

init();

async function init() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const values = migrateSettings({ ...DEFAULTS, ...settings });
  state.previousSettings = values;
  state.profiles = values.modelProfiles;
  state.activeProfileId = values.activeProfileId;
  fields.connectionMode.value = values.connectionMode;
  fields.responseLanguage.value = values.responseLanguage || DEFAULTS.responseLanguage;
  renderProfileSelect();
  loadProfile(state.activeProfileId);
  updateModeSections();
  if (!settings.modelProfiles?.length) await chrome.storage.local.set({ settings: values });
}

function migrateSettings(settings) {
  if (Array.isArray(settings.modelProfiles) && settings.modelProfiles.length) {
    const active = settings.modelProfiles.find((item) => item.id === settings.activeProfileId) || settings.modelProfiles[0];
    return { ...settings, ...active, activeProfileId: active.id };
  }
  const profile = profileFromValues(settings.activeProfileId || "default", settings.model || "默认模型", settings);
  return { ...settings, activeProfileId: profile.id, modelProfiles: [profile] };
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
  const settings = { ...DEFAULTS, ...state.previousSettings, ...active, connectionMode:webMode ? "chatgpt_web" : "api", activeProfileId:active.id, modelProfiles:state.profiles, responseLanguage, language:responseLanguageCode(responseLanguage) };
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
