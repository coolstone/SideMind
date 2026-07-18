const TEMPLATE_VARIABLE_PATTERN = /\$\{([^{}\s]+)\}/g;

function extractTemplateVariables(template) {
  const names = [];
  const seen = new Set();
  for (const match of String(template || "").matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function interpolatePromptTemplate(template, values = {}) {
  return String(template || "").replace(TEMPLATE_VARIABLE_PATTERN, (placeholder, name) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? "") : placeholder;
  });
}

function templateVariableLabel(name) {
  return ({
    lang: "目标语言",
    input: "输入内容",
    industry: "行业名称",
    topic: "主题",
    tone: "语气",
    audience: "目标读者"
  })[name] || name.replace(/[_-]+/g, " ");
}

function templateVariableHint(name) {
  return ({
    lang: "例如：简体中文、English、日本語",
    input: "可填写文字，也可自动使用当前网页选区或输入框内容",
    industry: "例如：新能源汽车、生成式 AI",
    topic: "请输入需要处理的主题",
    tone: "例如：专业、简洁、亲切",
    audience: "例如：产品经理、普通消费者"
  })[name] || `填写 \${${name}} 的值`;
}
