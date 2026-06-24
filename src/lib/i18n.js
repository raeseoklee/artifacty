export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "ko"];

const TRANSLATIONS = {
  en: {
    "nav.new": "New",
    "nav.import": "Import",
    "nav.api": "API",
    "nav.index": "Index",
    "nav.cancel": "Cancel",
    "nav.artifact": "Artifact",
    "nav.edit": "Edit",
    "nav.diff": "Diff",
    "nav.raw": "Raw",
    "language.english": "English",
    "language.korean": "Korean",
    "dashboard.count": "{count} artifacts",
    "dashboard.empty": "No artifacts published yet.",
    "filter.search": "Search",
    "filter.tag": "Tag",
    "filter.source": "Source",
    "filter.archived": "Archived",
    "filter.submit": "Filter",
    "filter.clear": "Clear",
    "form.newTitle": "New Artifact",
    "form.editTitle": "Edit {title}",
    "form.title": "Title",
    "form.format": "Format",
    "form.source": "Source",
    "form.type": "Type",
    "form.tags": "Tags",
    "form.content": "Content",
    "form.saveVersion": "Save Version",
    "form.create": "Create",
    "form.importTitle": "Import Artifact",
    "form.agent": "Agent",
    "form.auto": "Auto",
    "form.fileName": "File Name",
    "form.importContent": "Content or JSON Payload",
    "form.importSubmit": "Import",
    "artifact.schema": "schema v{version}",
    "artifact.archived": "archived {date}",
    "artifact.bytes": "{size} bytes",
    "artifact.archive": "Archive",
    "artifact.restore": "Restore",
    "diff.title": "{title} Diff",
    "diff.from": "From",
    "diff.to": "To",
    "diff.line": "Line",
    "diff.compare": "Compare",
    "editor.formatJson": "Format JSON",
    "editor.validJson": "Valid JSON",
    "editor.invalidJson": "Invalid JSON: {message}",
    "editor.htmlPreview": "HTML preview",
    "editor.markdownPreview": "Markdown preview",
    "editor.plainText": "Plain text",
    "editor.mode": "{format} editor"
  },
  ko: {
    "nav.new": "새로 만들기",
    "nav.import": "가져오기",
    "nav.api": "API",
    "nav.index": "목록",
    "nav.cancel": "취소",
    "nav.artifact": "아티팩트",
    "nav.edit": "편집",
    "nav.diff": "비교",
    "nav.raw": "원본",
    "language.english": "영어",
    "language.korean": "한국어",
    "dashboard.count": "아티팩트 {count}개",
    "dashboard.empty": "아직 게시된 아티팩트가 없습니다.",
    "filter.search": "검색",
    "filter.tag": "태그",
    "filter.source": "소스",
    "filter.archived": "보관됨",
    "filter.submit": "필터",
    "filter.clear": "초기화",
    "form.newTitle": "새 아티팩트",
    "form.editTitle": "{title} 편집",
    "form.title": "제목",
    "form.format": "포맷",
    "form.source": "소스",
    "form.type": "유형",
    "form.tags": "태그",
    "form.content": "내용",
    "form.saveVersion": "버전 저장",
    "form.create": "생성",
    "form.importTitle": "아티팩트 가져오기",
    "form.agent": "에이전트",
    "form.auto": "자동",
    "form.fileName": "파일 이름",
    "form.importContent": "내용 또는 JSON 페이로드",
    "form.importSubmit": "가져오기",
    "artifact.schema": "스키마 v{version}",
    "artifact.archived": "보관됨 {date}",
    "artifact.bytes": "{size} 바이트",
    "artifact.archive": "보관",
    "artifact.restore": "복원",
    "diff.title": "{title} 비교",
    "diff.from": "이전",
    "diff.to": "이후",
    "diff.line": "라인",
    "diff.compare": "비교",
    "editor.formatJson": "JSON 정리",
    "editor.validJson": "유효한 JSON",
    "editor.invalidJson": "유효하지 않은 JSON: {message}",
    "editor.htmlPreview": "HTML 미리보기",
    "editor.markdownPreview": "Markdown 미리보기",
    "editor.plainText": "일반 텍스트",
    "editor.mode": "{format} 편집기"
  }
};

export function resolveLocale(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (SUPPORTED_LOCALES.includes(normalized)) {
    return normalized;
  }
  return DEFAULT_LOCALE;
}

export function localeFromUrl(url) {
  return resolveLocale(url.searchParams.get("lang") || process.env.ARTIFACTY_LOCALE);
}

export function localeFromBodyOrUrl(body = {}, url) {
  return resolveLocale(body.lang || url.searchParams.get("lang") || process.env.ARTIFACTY_LOCALE);
}

export function createI18n(locale = DEFAULT_LOCALE) {
  const resolved = resolveLocale(locale);
  const messages = TRANSLATIONS[resolved] || TRANSLATIONS[DEFAULT_LOCALE];

  return {
    locale: resolved,
    t(key, params = {}) {
      const template = messages[key] || TRANSLATIONS[DEFAULT_LOCALE][key] || key;
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => String(params[name] ?? ""));
    }
  };
}

export function localizedHref(href, locale) {
  const resolved = resolveLocale(locale);
  if (resolved === DEFAULT_LOCALE) {
    return stripLocale(href);
  }
  const url = new URL(href, "http://artifacty.local");
  url.searchParams.set("lang", resolved);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function switchLocaleHref(currentPath, locale) {
  return localizedHref(currentPath || "/", locale);
}

export function editorMessages(locale = DEFAULT_LOCALE) {
  const { t } = createI18n(locale);
  return {
    formatJson: t("editor.formatJson"),
    validJson: t("editor.validJson"),
    invalidJson: t("editor.invalidJson", { message: "{message}" }),
    htmlPreview: t("editor.htmlPreview"),
    markdownPreview: t("editor.markdownPreview"),
    plainText: t("editor.plainText"),
    mode: t("editor.mode", { format: "{format}" })
  };
}

function stripLocale(href) {
  const url = new URL(href, "http://artifacty.local");
  url.searchParams.delete("lang");
  return `${url.pathname}${url.search}${url.hash}`;
}
