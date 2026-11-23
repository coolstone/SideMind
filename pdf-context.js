/*
 * SideMind PDF context helpers.
 *
 * PDF.js is bundled locally in vendor/pdfjs.  The source file and its worker
 * are Apache-2.0; see vendor/pdfjs/LICENSE and vendor/pdfjs/package.json.
 * This module deliberately never persists a PDF ArrayBuffer.  Callers keep
 * the returned `runtime` value in memory and persist only `stored`.
 */
(function registerPdfContext(global) {
  const MAX_PDF_BYTES = 20 * 1024 * 1024;
  const MAX_PDF_PAGES = 200;
  const MAX_DOCUMENT_MAP_CHARS = 16000;
  const MAX_REFERENCE_EXCERPT_CHARS = 9000;
  const MAX_VISION_PAGES = 4;
  let pdfJsPromise;

  function pdfError(message) {
    const error = new Error(message);
    error.code = "PDF_CONTEXT_ERROR";
    return error;
  }

  async function loadPdfJs() {
    if (!pdfJsPromise) {
      pdfJsPromise = import(chrome.runtime.getURL("vendor/pdfjs/pdf.mjs"))
        .then((pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");
          return pdfjs;
        });
    }
    return pdfJsPromise;
  }

  function assertPdfSize(size, label = "PDF 文件") {
    if (Number(size) > MAX_PDF_BYTES) throw pdfError(`${label} 超过 20MB 限制，请拆分后重试`);
  }

  function isPdfBytes(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    return data.length >= 5 && String.fromCharCode(...data.slice(0, 5)) === "%PDF-";
  }

  function isPdfUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && (/\.pdf(?:$|[?#])/i.test(url.pathname + url.search) || /(?:^|[?&])(?:file|format|download)=[^&]*pdf/i.test(url.search));
    } catch {
      return false;
    }
  }

  function normalizePageText(items) {
    let result = "";
    for (const item of items || []) {
      const text = String(item?.str || "").replace(/\u0000/g, "");
      if (!text) continue;
      if (result && !/[\s\n]$/.test(result) && !/^[,.;:!?，。；：！？、】【）】》”]/.test(text)) result += " ";
      result += text;
      if (item?.hasEOL && !result.endsWith("\n")) result += "\n";
    }
    return result
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function titleHint(text, pageNumber) {
    const first = String(text || "").split(/\n+/).map((line) => line.trim()).find(Boolean) || "";
    if (!first) return `第 ${pageNumber} 页`;
    return first.slice(0, 90).replace(/\s+/g, " ");
  }

  function buildDocumentMap(pages, budget = MAX_DOCUMENT_MAP_CHARS) {
    pages = pages || [];
    const normalizedBudget = Math.max(1200, Math.min(MAX_DOCUMENT_MAP_CHARS, Number(budget) || MAX_DOCUMENT_MAP_CHARS));
    const headers = pages.map((page) => `[p. ${page.pageNumber}]`);
    const baseSize = headers.join("\n\n").length;
    if (baseSize > normalizedBudget) throw new Error("概览预算不足以覆盖全部页码，请提高预算。");
    let remaining = normalizedBudget - baseSize;
    const entries = pages.map((page, index) => {
      const allowance = Math.floor(remaining / (pages.length - index));
      const text = String(page.text || "").replace(/\s+/g, " ").trim();
      const title = String(page.titleHint || titleHint(page.text, page.pageNumber)).slice(0, Math.min(35, Math.floor(allowance / 3)));
      const excerpt = text.slice(0, Math.max(0, Math.min(320, allowance - title.length - 2)));
      const extra = (title ? " " + title : "") + (excerpt ? "\n" + excerpt : "");
      remaining -= extra.length;
      return { pageNumber: page.pageNumber, titleHint: title, excerpt, truncated: excerpt.length < text.length };
    });
    const text = entries.map((entry, index) => headers[index] + (entry.titleHint ? " " + entry.titleHint : "") + (entry.excerpt ? "\n" + entry.excerpt : "")).join("\n\n");
    return { entries, text, coveredPages: entries.length, totalPages: pages.length, truncated: entries.some((entry) => entry.truncated) };
  }

  function detectTextStatus(pages) {
    const characters = (pages || []).reduce((total, page) => total + String(page.text || "").replace(/\s/g, "").length, 0);
    const threshold = Math.max(80, Math.min(600, (pages || []).length * 18));
    return characters < threshold ? "scanned" : "text";
  }

  function parsePageRange(value, pageCount) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const values = new Set();
    for (const fragment of raw.split(/[，,]/).map((item) => item.trim()).filter(Boolean)) {
      const range = fragment.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      const single = fragment.match(/^\d+$/);
      if (!range && !single) throw pdfError("页码格式不正确，请使用 3、5-8 或 1,3,6-9");
      const start = Number(range?.[1] || fragment);
      const end = Number(range?.[2] || fragment);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
        throw pdfError(`页码必须在 1 到 ${pageCount} 之间，且范围起点不能大于终点`);
      }
      for (let page = start; page <= end; page += 1) values.add(page);
    }
    return [...values].sort((a, b) => a - b);
  }

  function pageRangeLabel(pages) {
    if (!pages?.length) return "全文概览";
    const parts = [];
    let start = pages[0];
    let previous = pages[0];
    for (const page of pages.slice(1)) {
      if (page === previous + 1) {
        previous = page;
        continue;
      }
      parts.push(start === previous ? String(start) : `${start}-${previous}`);
      start = page;
      previous = page;
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    return `第 ${parts.join("、")} 页`;
  }

  function buildSelectedText(runtime, pages, budget) {
    const selected = new Set(pages || []);
    const sourcePages = runtime?.pages?.filter((page) => selected.has(page.pageNumber)) || [];
    if (!sourcePages.length) throw pdfError("没有可用于提问的 PDF 页面，请先输入有效页码范围");
    const fullText = sourcePages.map((page) => `[p. ${page.pageNumber}]\n${page.text}`).join("\n\n");
    if (fullText.length > budget) {
      throw pdfError(`所选 ${pageRangeLabel(pages)} 的文字约 ${fullText.length.toLocaleString("zh-CN")} 字，超过当前上下文预算 ${budget.toLocaleString("zh-CN")} 字；请缩小页码范围后重试`);
    }
    return { text: fullText, pages: sourcePages };
  }

  function buildReferencePages(pages) {
    let remaining = MAX_REFERENCE_EXCERPT_CHARS;
    const references = [];
    for (const page of pages || []) {
      if (remaining <= 0) break;
      const excerpt = String(page.text || "").slice(0, Math.min(1400, remaining));
      references.push({ pageNumber: page.pageNumber, titleHint: page.titleHint || titleHint(page.text, page.pageNumber), excerpt });
      remaining -= excerpt.length;
    }
    return references;
  }

  function storedPdfContext(runtime, selectedPages = []) {
    const map = runtime.documentMap || buildDocumentMap(runtime.pages || []);
    const selected = Array.isArray(selectedPages) ? selectedPages : [];
    const selectedPageObjects = runtime.pages?.filter((page) => selected.includes(page.pageNumber)) || [];
    return {
      id: runtime.id,
      sourceType: runtime.sourceType,
      name: runtime.name,
      url: runtime.url || "",
      pageCount: runtime.pageCount,
      textStatus: runtime.textStatus,
      documentMap: map,
      selectedPages: selected,
      selectedRangeLabel: pageRangeLabel(selected),
      referencedPages: buildReferencePages(selectedPageObjects),
      restored: false
    };
  }

  async function parsePdfBytes(bytes, source) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    assertPdfSize(data.byteLength, source?.name || "PDF 文件");
    if (!isPdfBytes(data)) throw pdfError("文件不是有效的 PDF，或服务器返回了登录页/错误页面");
    const pdfjs = await loadPdfJs();
    let documentProxy;
    try {
      documentProxy = await pdfjs.getDocument({ data }).promise;
    } catch (error) {
      if (/password/i.test(String(error?.message || ""))) throw pdfError("该 PDF 受密码保护，暂不支持读取");
      throw pdfError(`无法解析 PDF：${error?.message || "文件可能已损坏或受保护"}`);
    }
    if (documentProxy.numPages > MAX_PDF_PAGES) {
      await documentProxy.destroy();
      throw pdfError(`PDF 共 ${documentProxy.numPages} 页，超过 ${MAX_PDF_PAGES} 页限制，请拆分后重试`);
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizePageText(content.items);
      pages.push({ pageNumber, text, titleHint: titleHint(text, pageNumber) });
    }
    const textStatus = detectTextStatus(pages);
    const documentMap = buildDocumentMap(pages);
    return {
      id: crypto.randomUUID(),
      sourceType: source?.sourceType || "local",
      name: source?.name || "未命名 PDF",
      url: source?.url || "",
      pageCount: documentProxy.numPages,
      textStatus,
      documentMap,
      pages,
      documentProxy,
      sourceBytes: data
    };
  }

  async function fetchPublicPdf(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw pdfError("PDF 链接无效");
    }
    if (!/^https?:$/.test(parsed.protocol)) throw pdfError("只能读取可直接访问的公共 HTTP(S) PDF");
    let response;
    try {
      response = await fetch(parsed.href, { credentials: "omit", redirect: "follow" });
    } catch (error) {
      throw pdfError(`下载公共 PDF 失败：${error.message || "网络不可用"}`);
    }
    if (!response.ok) throw pdfError(`下载公共 PDF 失败（HTTP ${response.status}）。请确认链接可直接打开且无需登录`);
    const length = Number(response.headers.get("content-length") || 0);
    assertPdfSize(length, "公共 PDF");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertPdfSize(bytes.byteLength, "公共 PDF");
    if (!isPdfBytes(bytes)) throw pdfError("该链接没有返回 PDF 文件，可能需要登录、跳转到了预览器或服务器返回了错误页");
    return { bytes, name: decodeURIComponent(parsed.pathname.split("/").pop() || "网页 PDF") || "网页 PDF", url: response.url || parsed.href };
  }

  async function renderPagesForVision(runtime, pages) {
    if (!runtime?.documentProxy) throw pdfError("PDF 已从内存中移除。请重新打开或附加原 PDF 后再发送视觉页");
    if (!pages?.length) throw pdfError("扫描件需要先填写要阅读的页码范围");
    if (pages.length > MAX_VISION_PAGES) throw pdfError(`扫描件一次最多发送 ${MAX_VISION_PAGES} 页，请缩小页码范围`);
    const images = [];
    for (const pageNumber of pages) {
      const page = await runtime.documentProxy.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1.65, 1500 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: Math.max(0.8, scale) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, background: "#fff" }).promise;
      images.push({
        name: `${runtime.name.replace(/\.pdf$/i, "")}-p${pageNumber}.jpg`,
        kind: "image",
        type: "image/jpeg",
        dataUrl: canvas.toDataURL("image/jpeg", 0.78),
        source: "pdf-page",
        pdfPageNumber: pageNumber
      });
    }
    return images;
  }

  global.SideMindPdf = {
    MAX_PDF_BYTES,
    MAX_PDF_PAGES,
    MAX_DOCUMENT_MAP_CHARS,
    MAX_VISION_PAGES,
    isPdfUrl,
    parsePageRange,
    pageRangeLabel,
    buildDocumentMap,
    detectTextStatus,
    buildSelectedText,
    buildReferencePages,
    storedPdfContext,
    parsePdfBytes,
    fetchPublicPdf,
    renderPagesForVision
  };
})(globalThis);
