const PROMPT_LIBRARY_VERSION = 5;

const DEFAULT_PROMPTS = [
  { id: "prompt-brief", name: "百字总结", content: "做一个100字左右的总结，不超过120字。", category: "reading", visible: true },
  { id: "sider-summary", name: "总结", content: "请阅读提供的内容并生成清晰的结构化总结：先用一句话给出核心结论，再列出 5—8 条关键要点；保留重要人物、组织、日期、数字、因果关系和争议点。事实与推断分开表达，信息不足时明确说明。", category: "reading", visible: true },
  { id: "sider-explain", name: "解释", content: "请用通俗、准确的语言解释提供的内容。依次说明：它在讲什么、关键概念是什么意思、各部分如何关联、为什么重要，并给出一个具体例子。避免只做同义改写；遇到不确定信息要明确标注。", category: "chat", visible: true },
  { id: "sider-translate", name: "翻译", content: "请识别原文语言并翻译：中文译为自然、准确的英文，其他语言译为简体中文。保持原有段落、标题、列表、数字、链接和专有名词；优先传达真实含义与语气，不逐字硬译，不增删事实。", category: "reading", visible: true },
  { id: "sider-word-translate", name: "翻译单词", content: "请分析用户提供的单词或短语，并按以下结构回答：1. 音标与词性；2. 最常用中文释义；3. 不同语境下的含义；4. 常见搭配；5. 3 个由浅入深的双语例句；6. 易混词及区别。若存在拼写问题，先指出并给出正确形式。", category: "chat", visible: true },
  { id: "sider-vocabulary-card", name: "生成单词记忆卡片", content: "请把提供的单词制作成便于复习的记忆卡片。每张卡片包含：单词、音标、词性、核心释义、词根词缀或联想记忆、常用搭配、一个地道例句及翻译、同反义词、一个自测填空题。内容简洁，优先高频用法。", category: "chat", visible: true },
  { id: "sider-master-tutor", name: "名师指导", content: "请以经验丰富的学科教师身份指导我。先判断问题涉及的知识点和我的可能卡点，再用“核心原理—分步推导—典型例题—常见错误—迁移练习”的结构讲解。不要直接跳到答案；关键步骤要说明为什么，并在结尾给出 3 道由易到难的自测题。", category: "chat", visible: true },
  { id: "sider-english-reading", name: "英文文章阅读与词汇复习助手", content: "请作为英文阅读与词汇复习助手处理提供的文章：1. 用中英文各写一段摘要；2. 梳理文章结构和作者观点；3. 提取 10—15 个值得学习的词汇或短语，给出音标、释义、原文语境和例句；4. 解释长难句；5. 生成 5 道理解题和答案；6. 给出可复习的词汇清单。", category: "reading", visible: true },
  { id: "sider-wechat-article", name: "公众号文章", content: "请把素材改写成适合微信公众号发布的文章。要求：拟 5 个有吸引力但不夸张的标题；开头用真实问题或场景引入；正文结构清晰、段落短、适合手机阅读；保留事实、数据和来源边界；加入小标题、案例和可执行建议；结尾总结并自然引导互动。避免 AI 腔、空话和标题党。", category: "writing", visible: true },
  { id: "sider-wechat-article-refined", name: "公众号文章（精华版）", content: "请将素材精炼为高质量微信公众号文章。先提炼一个鲜明中心观点，删除重复与低价值内容，再按“引人入胜的开场—3 至 5 个递进章节—关键洞察—行动建议—余味结尾”重写。语言有节奏、有观点但不过度煽情；重要事实和数字不得改动。输出标题备选、摘要、正文和封面文案。", category: "writing", visible: true },
  { id: "sider-industry-map", name: "行业分析-1市场地图", content: "请构建目标行业的市场地图。按细分赛道列出代表性企业、目标客户、核心产品、商业模式、竞争优势、市场位置和主要差异；分析市场规模与增长驱动、集中度、区域分布、竞争格局、新进入者机会和潜在替代。无法确认的数据标记为“待核实”，不要编造具体数值。", category: "reading", visible: true },
  { id: "sider-industry-customer", name: "行业分析-2客户与运营", content: "请从客户与运营视角分析目标行业。说明客户分层、典型使用场景、采购决策链、核心需求与痛点、获客渠道、转化路径、交付流程、留存与复购、服务体系、关键运营指标和常见瓶颈。最后给出客户旅程、运营指标树和 5 条可验证的改进建议。", category: "reading", visible: true },
  { id: "sider-industry-ecosystem", name: "行业分析-3商业架构与生态", content: "请对目标行业进行商业架构与生态分析。覆盖：价值链与利润池、上中下游角色、核心产品和服务、关键资源与能力、收入模式和成本结构、渠道与合作伙伴、平台及标准、进入壁垒、替代关系、主要风险。最后用生态角色表和商业模式画布总结，并区分已知事实与待验证假设。", category: "reading", visible: true },
  { id: "sider-paragraph", name: "段落", content: "请围绕给定主题写一个完整段落。第一句明确中心观点，中间用事实、逻辑或例子展开，最后自然收束。保持语气与上下文一致，避免重复、空话和生硬连接；如未指定长度，控制在 150—250 字。", category: "writing", visible: false },
  { id: "sider-social-post", name: "发布社交媒体", content: "请把素材改写成适合社交媒体发布的内容。输出一个简洁主帖和 3 个不同语气的备选版本；开头快速抓住注意力，正文突出一个核心信息，保留必要事实，结尾加入自然的互动问题。根据内容推荐少量相关标签，避免夸张承诺和营销套话。", category: "writing", visible: false },
  { id: "sider-news-release", name: "新闻稿", content: "请根据素材撰写规范新闻稿，包含标题、导语、正文、背景信息和联系信息占位符。导语回答谁、何时、何地、做了什么、为什么重要；正文按重要性递减组织，引用内容不得虚构，事实、数字和时间必须与素材一致。", category: "writing", visible: false },
  { id: "sider-creative-story", name: "创意故事", content: "请基于给定主题创作一个有完整弧线的故事。明确人物目标、阻力、选择和变化；用场景、动作和对话推进，避免大段解释。开头建立悬念，中段出现有效转折，结尾回应主题但不过度说教。若未指定风格，采用克制、具象、易读的现代叙事。", category: "writing", visible: false },
  { id: "sider-action-plan", name: "行动计划", content: "请把目标转化为可执行行动计划。先明确目标、范围和成功标准，再按阶段列出任务、负责人、优先级、时间节点、依赖、交付物和风险应对；区分立即行动、短期和中期事项。最后给出本周可启动的 3 个最小行动。", category: "chat", visible: false },
  { id: "sider-meeting-agenda", name: "会议议程", content: "请生成高效会议议程，包含会议目标、会前材料、参会角色、各议题时间、主持人、讨论问题、需要形成的决策和会后行动项。控制总时长，优先安排需要决策的议题，并预留总结与确认责任人的时间。", category: "writing", visible: false },
  { id: "sider-marketing-email", name: "营销邮件", content: "请根据产品、受众和目标撰写营销邮件。输出 5 个主题行、预览文字、正文和明确行动按钮文案。正文从受众痛点出发，说明具体价值与可信依据，处理一个主要顾虑；语言简洁、个性化，避免虚假稀缺、夸张承诺和垃圾邮件式表达。", category: "writing", visible: false },
  { id: "sider-continue-writing", name: "续写", content: "请沿用原文的人称、语气、节奏、世界观和事实继续写作。先识别尚未完成的逻辑或情节，再自然承接，不重复已有内容，不突然改变风格或引入无依据设定。若原文信息不足，选择最保守且连贯的延伸。", category: "writing", visible: false },
  { id: "sider-persuasive", name: "更具说服力", content: "请在不改变事实的前提下增强文本说服力。明确目标受众和主张，补强论证结构、证据与因果关系，回应可能的反对意见，并把抽象价值转化为具体收益。删除空洞口号和绝对化表达，输出优化稿及主要修改说明。", category: "writing", visible: false },
  { id: "sider-add-details", name: "添加细节", content: "请为原文补充有助于理解的具体细节，包括必要背景、步骤、场景、例子和感官信息，同时保持原意、语气和事实边界。不要虚构人物、数据或来源；无法确定的内容用占位符或待确认问题表示。", category: "writing", visible: false },
  { id: "sider-add-data", name: "添加数据", content: "请识别原文中哪些观点需要数据支持，并给出数据需求清单：指标定义、时间范围、地域范围、建议来源和验证方法。只能使用用户提供且可核查的数据；缺少真实数据时不要编造数值，而应提供占位符、计算公式或检索建议。", category: "writing", visible: false },
  { id: "prompt-summary", name: "深度总结", content: "请先给出一句话结论，再按主题总结关键论点、证据、数字与值得追问的问题。", category: "reading", visible: true },
  { id: "prompt-explain", name: "通俗解释", content: "请用没有专业背景的人也能理解的方式解释内容，并给出一个具体例子。", category: "chat", visible: true },
  { id: "prompt-actions", name: "提取行动项", content: "请提取所有行动项，按负责人、事项、截止时间、依赖和风险整理；原文缺失的字段标记为未说明。", category: "reading", visible: true },
  { id: "prompt-rewrite", name: "专业改写", content: "请在不改变事实和原意的前提下，把内容改写得清晰、专业、自然。", category: "writing", visible: true }
];

function buildPromptLibrary(exactPrompts = []) {
  const aliases = new Map([
    ["summarize", "总结"],
    ["explain", "解释"],
    ["translate", "翻译"]
  ]);
  const exactByName = new Map();
  for (const prompt of Array.isArray(exactPrompts) ? exactPrompts : []) {
    const sourceName = String(prompt?.name || "").trim();
    const targetName = aliases.get(sourceName.toLowerCase()) || sourceName;
    if (targetName && prompt?.content) exactByName.set(targetName.toLowerCase(), prompt);
  }
  return DEFAULT_PROMPTS.map((prompt) => {
    const exact = exactByName.get(prompt.name.trim().toLowerCase());
    if (!exact) return prompt;
    const content = prompt.id === "sider-industry-map"
      ? String(exact.content).replace(/\[INSERT INDUSTRY NAME\]/gi, "${industry}")
      : exact.content;
    return { ...prompt, content, sourceName: exact.name };
  });
}

async function loadExactPromptLibrary() {
  try {
    const response = await fetch(chrome.runtime.getURL("sider-prompt-captures.json"));
    if (!response.ok) return [];
    const prompts = await response.json();
    return Array.isArray(prompts) ? prompts : [];
  } catch {
    return [];
  }
}

function mergePromptLibrary(existingPrompts, exactPrompts = []) {
  const library = buildPromptLibrary(exactPrompts);
  const existing = Array.isArray(existingPrompts) ? existingPrompts : [];
  const defaultsById = new Map(library.map((item) => [item.id, item]));
  const migrated = existing.map((item) => {
    const nextDefault = defaultsById.get(item.id);
    if (!nextDefault || item.source !== "sider-equivalent") return item;
    return { ...nextDefault, visible: item.visible !== false, source: "sider-equivalent" };
  });
  const ids = new Set(migrated.map((item) => item.id).filter(Boolean));
  const names = new Set(migrated.map((item) => String(item.name || "").trim().toLowerCase()).filter(Boolean));
  const additions = library.filter((item) => !ids.has(item.id) && !names.has(item.name.trim().toLowerCase()));
  return [...migrated, ...additions.map((item) => ({ ...item, source: "sider-equivalent" }))];
}
