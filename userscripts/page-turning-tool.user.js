// ==UserScript==
// @name         翻页工具
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.8.0
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/page-turning-tool.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/page-turning-tool.user.js
// @description  自动识别网页上一页和下一页，并显示独立悬浮翻页按钮。
// @author       Scripting Agent
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-end
// @grant        GM.log
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__pageTurningToolInstanceV1__";
  const previousInstance = document[INSTANCE_KEY];
  // 旧实例的闭包可能已随页面重写失效；resume 抛错或未确认成功时必须继续完整启动。
  if (previousInstance?.resume) {
    let resumed = false;
    try {
      resumed = previousInstance.resume("reinjected") === true;
    } catch (_) {
      resumed = false;
    }
    if (resumed) return;
    try { document[INSTANCE_KEY] = null; } catch (_) {}
  }
  const INSTANCE = { phase: "starting", resume: null };
  document[INSTANCE_KEY] = INSTANCE;
  const SCRIPT_ID = "floating-page-navigation";
  const STYLE_ID = `${SCRIPT_ID}-style`;
  const ITEM_SIZE = /(^|\.)nodeseek\.com$/i.test(location.hostname) ? 32 : 40;
  const WIDTH = ITEM_SIZE * 2;
  const DEFAULT_RIGHT_GAP = 140;
  const DEFAULT_BOTTOM_GAP = 40;
  const SHARED_URL_CHANGE_EVENT = "scripts:urlchange";
  const SHARED_HISTORY_HOOK_KEY = "__sharedHistoryHookV1__";
  const STATE = {
    prev: null,
    next: null,
    navigating: false,
    initialized: false,
    observer: null,
    toolbar: null,
    styleElement: null,
    prevButton: null,
    nextButton: null,
    listenersInstalled: false,
    pagerObserver: null,
    observedPagerRoot: null,
    updateTimer: null,
    idleHandle: null,
    idleUsesRequestCallback: false,
    updateInFlight: false,
    updateDirty: false,
    hydrationTimer: null,
    hydrationRetried: false,
    pendingRefreshFlags: 0,
    refreshScheduled: false,
    refreshFrame: null,
    refreshFallbackTimer: null,
    refreshToken: 0,
    contentDelay: Infinity,
    domEpoch: 0,
    pagerCache: null,
    candidateEpoch: -1,
    mutationScanAt: 0,
    mutationCatchupTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function log(...args) {
    try {
      if (typeof GM !== "undefined" && GM.log) GM.log("[翻页菜单]", ...args);
      else console.log("[翻页菜单]", ...args);
    } catch (_) {}
  }

  // 先用一次 getBoundingClientRect 淘汰绝大多数零尺寸元素，
  // 只有真正有尺寸的候选才付出 getComputedStyle 的代价。
  function visible(el) {
    if (!el || !(el instanceof Element) || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  // SVG 元素的 className 是 SVGAnimatedString，不能直接当字符串用，统一走 getAttribute。
  function classText(el) {
    return el?.getAttribute?.("class") || "";
  }

  function disabled(el) {
    if (!el) return true;
    const anchorWithoutHref = el.tagName === "A" && !el.getAttribute("href") && !el.onclick;
    return Boolean(
      el.disabled ||
      el.getAttribute("aria-disabled") === "true" ||
      /(^|\s)(disabled|disable|unavailable|inactive)(\s|$)/i.test(classText(el)) ||
      (anchorWithoutHref && !el.hasAttribute("data-page") && !paginationContainer(el))
    );
  }

  function labelledByText(el) {
    const ids = String(el?.getAttribute?.("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
  }

  // 只读 textContent：innerText 会强制同步布局，而这里的用途是关键词匹配，
  // textContent 是它的超集，足够且不触发 reflow。
  function normalizeText(el) {
    return [
      el.textContent,
      el.getAttribute("aria-label"),
      labelledByText(el),
      el.getAttribute("title"),
      el.getAttribute("rel"),
      el.getAttribute("class"),
      el.getAttribute("id"),
      el.getAttribute("data-page"),
      el.querySelector?.("img[alt]")?.getAttribute("alt"),
      el.querySelector?.("svg title")?.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const PAGINATION_CONTAINER_SELECTOR = '.pagination, .pager, .pages, .page-list, .pagebar, .page-numbers, [class*="pagination" i], [class*="pager" i], [class*="page-list" i], [class*="pagebar" i], [class*="pages" i], [id*="pagination" i], [id*="pager" i], [role="navigation"][aria-label*="page" i], [role="navigation"][aria-label*="分页"], [aria-label="pagination" i], [aria-label*="page navigation" i]';
  // 播放器 / 轮播 / 推荐区：这些区域的 next/prev 按钮与翻页无关。
  const MEDIA_CONTEXT_SELECTOR = 'video, .swiper, .carousel, .slider, .slick, .glide, [class*="swiper" i], [class*="carousel" i], [class*="slider" i], [class*="player" i], [class*="recommend" i], [class*="related" i]';

  function paginationContainer(el) {
    return el?.closest?.(PAGINATION_CONTAINER_SELECTOR) || null;
  }

  function deniedPaginationCandidate(el) {
    if (!el) return true;
    const all = `${normalizeText(el)} ${el.getAttribute?.('href') || ''} ${el.getAttribute?.('action') || ''}`;
    return Boolean(el.hasAttribute?.('download') || /pay(?:ment|wall)?|log[\s_-]?in|sign[\s_-]?in|download|preview|subscri(?:be|ption)|支付|付费|购买|登录|登陆|下载|预览|订阅/i.test(all));
  }

  function isOwnUiElement(el) {
    return Boolean(
      el?.closest?.(`#${SCRIPT_ID}`)
    );
  }

  function scoreCandidate(el, direction, context = null) {
    if (isOwnUiElement(el) || !visible(el) || disabled(el)) return -999;
    const inPagination = context ? context.inPagination : Boolean(paginationContainer(el));
    // 付费/登录/下载黑名单只对分页容器外的候选生效，
    // 否则会连带否掉分页区内含 "preview"、"订阅" 字样的正常页码链接。
    if (!inPagination && deniedPaginationCandidate(el)) return -999;
    const text = context ? context.text : normalizeText(el).toLowerCase();
    const href = context ? context.href : (el.getAttribute("href") || "").toLowerCase();
    const all = `${text} ${href}`;
    let score = 0;

    if (direction === "next") {
      if (/\bnext\b|下一页|下页|后一页|后页|下一章|下章|older|forward/.test(all)) score += 80;
      if (/[›»→＞>]|^\s*下\s*$/.test(text)) score += 65;
      if (/rel=["']?next|\bnext\b/.test(all) || el.getAttribute("rel") === "next") score += 70;
      if (inPagination && /加载更多|更多|\bload\s+more\b|\bmore\b/.test(text)) score += 80;
      if (/page[=/_-]?\d+|p=\d+|paged=\d+/.test(href)) score += 10;
    } else {
      if (/\bprev\b|\bprevious\b|上一页|上页|前一页|前页|上一章|上章|newer|\bback\b/.test(all)) score += 80;
      if (/[‹«←＜<]|^\s*上\s*$/.test(text)) score += 65;
      if (/rel=["']?prev|\bprev\b|\bprevious\b/.test(all) || el.getAttribute("rel") === "prev") score += 70;
      if (/page[=/_-]?\d+|p=\d+|paged=\d+/.test(href)) score += 10;
    }
    if (el.tagName === "A") score += 15;
    if (el.tagName === "BUTTON") score += 12;
    if (inPagination) score += 35;
    if (/comment|reply|share|广告|ad-|banner/.test(all)) score -= 40;
    // 播放器、轮播、推荐区的 next/prev 按钮（如 next-video、swiper-button-next）
    // 不是翻页，只有在分页容器外才罚分。
    if (!inPagination && (context ? context.inMedia : Boolean(el.closest?.(MEDIA_CONTEXT_SELECTOR)))) score -= 70;
    return score;
  }

  function uniqueElements(list) {
    return Array.from(new Set(list.filter(Boolean)));
  }

  function explicitCurrentElement(root) {
    return root?.querySelector?.('[aria-current="page"], [class~="current"], [class~="active"], [class~="selected"], .page-numbers.current, .page-numbers.active') || null;
  }

  function numericControlValue(el) {
    if (!el) return "";
    const dataValue = String(el.getAttribute?.("data-page") || el.getAttribute?.("data-page-number") || "").trim();
    if (/^0*\d{1,5}$/.test(dataValue)) return String(parseInt(dataValue, 10));
    const text = numericText(el);
    if (text) return text;
    const href = el.href || el.getAttribute?.("href") || "";
    return href ? pageFromUrl(href) : "";
  }

  const PAGE_QUERY_KEYS = ["page", "p", "paged", "pg", "pn", "pageNo", "pageNumber"];

  function hasPageUrlEvidence(el, page) {
    const href = el?.href || el?.getAttribute?.("href") || "";
    if (!href || !page) return false;
    try {
      const url = new URL(href, location.href);
      if (!/^https?:$/i.test(url.protocol) || url.origin !== location.origin) return false;
      if (PAGE_QUERY_KEYS.some((key) => url.searchParams.get(key) === String(page))) return true;
      if (new RegExp(`(?:page|p|pg|list)[/_-]?0*${page}(?:/|$|\\.html?$)`, "i").test(url.pathname)) return true;
      return new RegExp(`/0*${page}/?$`).test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function numericPagerRoot(el) {
    const explicit = paginationContainer(el);
    if (explicit) return explicit;
    const list = el?.closest?.("ul, ol");
    if (list) return list;
    const parent = el?.parentElement;
    if (parent?.tagName === "LI" && parent.parentElement) return parent.parentElement;
    return parent;
  }

  function detectNumericPager() {
    const explicitRoots = $$(PAGINATION_CONTAINER_SELECTOR);
    const controls = uniqueElements([
      ...$$('a[href], button, [role="button"], [data-page], [data-page-number], [aria-current="page"], [class~="current"], [class~="active"], [class~="selected"]'),
      ...explicitRoots.flatMap((root) => $$('a, button, [role="button"], [data-page], [data-page-number], [aria-current="page"], [class~="current"], [class~="active"], [class~="selected"]', root)),
    ]).filter((el) => !el.closest?.(`#${SCRIPT_ID}, #${SCRIPT_ID}-jump-mask`) && numericControlValue(el));
    const roots = uniqueElements(controls.map(numericPagerRoot)).filter((root) => root && root !== document.body && root !== document.documentElement);
    const urlCurrent = parseInt(pageFromUrl() || "", 10);
    let best = null;

    for (const root of roots) {
      try {
        if (!visible(root) || root.querySelector("video") || root.querySelectorAll("img").length > 3) continue;
        if (/calendar|datepicker|date-picker|carousel|slider|tabs?|years?|months?/i.test(`${classText(root)} ${root.id || ""} ${root.getAttribute?.("role") || ""}`)) continue;

        const items = uniqueElements($$('a, button, [role="button"], [data-page], [data-page-number], [aria-current="page"], [class~="current"], [class~="active"], [class~="selected"]', root));
        const byPage = new Map();
        for (const el of items) {
          const page = parseInt(numericControlValue(el) || "", 10);
          if (!Number.isFinite(page) || page < 1 || page > 99999) continue;
          const existing = byPage.get(page);
          const actionable = el.matches?.('a[href], button, [role="button"], [data-page], [data-page-number]');
          if (!existing || (actionable && !existing.matches?.('a[href], button, [role="button"], [data-page], [data-page-number]'))) byPage.set(page, el);
        }
        const pages = [...byPage.keys()].sort((a, b) => a - b);
        if (pages.length < 2) continue;

        const explicitRoot = Boolean(root.matches?.(PAGINATION_CONTAINER_SELECTOR));
        const currentEl = explicitCurrentElement(root);
        const explicitCurrent = parseInt(numericControlValue(currentEl) || "", 10);
        const urlNeighborsCurrent = Number.isFinite(urlCurrent) && (byPage.has(urlCurrent) || byPage.has(urlCurrent - 1) || byPage.has(urlCurrent + 1));
        const current = Number.isFinite(explicitCurrent) ? explicitCurrent : (urlNeighborsCurrent ? urlCurrent : NaN);
        const consecutive = pages.some((page, index) => index > 0 && page === pages[index - 1] + 1);
        const urlEvidence = [...byPage.entries()].filter(([page, el]) => hasPageUrlEvidence(el, page)).length;
        const dataEvidence = [...byPage.values()].filter((el) => el.hasAttribute?.("data-page") || el.hasAttribute?.("data-page-number")).length;
        const directionEvidence = Boolean(root.querySelector?.('a[rel~="next"], a[rel~="prev"], [class*="next" i], [class*="prev" i], [aria-label*="next" i], [aria-label*="prev" i], [aria-label*="上一页"], [aria-label*="下一页"]'));
        const structuralEvidence = urlEvidence >= 1 || dataEvidence >= 2 || directionEvidence;
        const genericTrusted = Number.isFinite(current) && consecutive && ((urlEvidence >= 2 || dataEvidence >= 2) || directionEvidence);
        if (!explicitRoot && !genericTrusted) continue;
        if (explicitRoot && (!consecutive || !structuralEvidence)) continue;
        if (explicitRoot && !Number.isFinite(current) && pages.length < 3 && !directionEvidence) continue;

        let inferredCurrent = current;
        if (!Number.isFinite(inferredCurrent) && directionEvidence && pages[0] === 2) inferredCurrent = 1;
        if (!Number.isFinite(inferredCurrent)) continue;

        const prev = byPage.get(inferredCurrent - 1) || null;
        const next = byPage.get(inferredCurrent + 1) || null;
        if (!prev && !next) continue;
        const rect = root.getBoundingClientRect();
        const score = (explicitRoot ? 100 : 0) + urlEvidence * 15 + (directionEvidence ? 20 : 0) + pages.length + Math.max(0, rect.top / Math.max(innerHeight, 1));
        if (!best || score > best.score) best = { root, currentPage: String(inferredCurrent), prev, next, score };
      } catch (error) {
        log("数字分页容器识别失败", error);
      }
    }
    return best;
  }

  // 数字分页快照缓存：只要 DOM 纪元与 URL 未变，就复用上次结果，
  // 避免 updateToolbar 与点击时重复全页建页码映射。
  function detectNumericPagerCached() {
    const cache = STATE.pagerCache;
    if (
      cache &&
      cache.epoch === STATE.domEpoch &&
      cache.href === location.href &&
      (!cache.value || (cache.value.root?.isConnected &&
        (!cache.value.prev || cache.value.prev.isConnected) &&
        (!cache.value.next || cache.value.next.isConnected)))
    ) {
      return cache.value;
    }
    const value = safeCall("数字分页识别失败", detectNumericPager, null);
    STATE.pagerCache = { epoch: STATE.domEpoch, href: location.href, value };
    return value;
  }

  function invalidatePagerCache() {
    STATE.domEpoch++;
    STATE.pagerCache = null;
  }

  function observePagerRoot(root) {
    if (STATE.observedPagerRoot === root) return;
    STATE.pagerObserver?.disconnect();
    STATE.pagerObserver = null;
    STATE.observedPagerRoot = root || null;
    if (!root?.isConnected) return;
    STATE.pagerObserver = new MutationObserver(() => {
      invalidatePagerCache();
      requestRefresh(REFRESH_CONTENT, 120);
    });
    STATE.pagerObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "class", "aria-current", "aria-disabled", "disabled", "hidden", "data-page"],
    });
  }

  function findByRel(direction) {
    const rel = direction === "next" ? "next" : "prev";
    return $$(`a[rel~="${rel}"]`).find((el) =>
      visible(el) && !disabled(el) && !isOwnUiElement(el) && !isCoverPreviewContext(el) &&
      (paginationContainer(el) || !deniedPaginationCandidate(el))
    ) || null;
  }

  function safeCall(label, fn, fallback = null) {
    try {
      return fn();
    } catch (error) {
      log(label, error);
      return fallback;
    }
  }

  // 通用候选扫描：一次遍历同时算出 prev / next，避免两个方向各扫一遍全页 DOM。
  // 先只在分页容器内找，未命中时才降级到全页。
  const GENERIC_SELECTOR = [
    "a[href]",
    "button",
    "input[type=button]",
    "[role=button]",
    "[data-page]",
    ".next",
    ".prev",
    ".previous",
    "[class*=next]",
    "[class*=prev]",
    "[aria-label]",
    "[aria-labelledby]",
    "[title]",
  ].join(",");
  const GENERIC_SCORE_FLOOR = 30; // 低于该分数认为误判风险较高
  // 快速粗筛：分页容器外的候选只有命中方向关键词才可能超过 GENERIC_SCORE_FLOOR，
  // 先用一次正则滄掉绝大多数元素，避免为它们跑 getComputedStyle / closest。
  const DIRECTION_HINT_RE = /next|prev|previous|older|newer|forward|back|下一|上一|下页|上页|下[页頁]|上[页頁]|前一|后一|下章|上章|加载更多|更多|more|[›»→＞‹«←＜]|page[=/_-]?\d+|[?&]p=\d+|paged=\d+/i;

  const COVER_PREVIEW_VIDEO_SELECTOR = "video.__mobile_preview__, video.preview:not(.hidden)";

  function isCoverPreviewContext(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest?.(".__mobile_preview_active__")) return true;
    if (el.matches?.(COVER_PREVIEW_VIDEO_SELECTOR) || el.querySelector?.(COVER_PREVIEW_VIDEO_SELECTOR)) return true;
    return Boolean(el.closest?.("a[href]")?.querySelector?.(COVER_PREVIEW_VIDEO_SELECTOR));
  }

  function scanGenericCandidates(elements, inPagination) {
    const result = { prev: null, next: null, prevScore: GENERIC_SCORE_FLOOR, nextScore: GENERIC_SCORE_FLOOR };
    for (const el of elements) {
      if (isOwnUiElement(el) || isCoverPreviewContext(el)) continue;
      const text = safeCall("候选文本计算失败", () => normalizeText(el).toLowerCase(), "");
      const href = (el.getAttribute?.("href") || "").toLowerCase();
      let elementInPagination = inPagination;
      if (!elementInPagination && !DIRECTION_HINT_RE.test(`${text} ${href}`)) {
        elementInPagination = Boolean(paginationContainer(el));
        if (!elementInPagination) continue;
      }
      const context = safeCall("候选上下文计算失败", () => ({
        inPagination: elementInPagination || Boolean(paginationContainer(el)),
        text,
        href,
        inMedia: Boolean(el.closest?.(MEDIA_CONTEXT_SELECTOR)),
      }), null);
      if (!context) continue;
      const prevScore = safeCall("候选元素评分失败", () => scoreCandidate(el, "prev", context), -999);
      if (prevScore > result.prevScore) {
        result.prev = el;
        result.prevScore = prevScore;
      }
      const nextScore = safeCall("候选元素评分失败", () => scoreCandidate(el, "next", context), -999);
      if (nextScore > result.nextScore) {
        result.next = el;
        result.nextScore = nextScore;
      }
    }
    return result;
  }

  function findGenericCandidates() {
    const paginationRoots = $$(PAGINATION_CONTAINER_SELECTOR).filter((root) => !isOwnUiElement(root));
    if (paginationRoots.length) {
      const scoped = scanGenericCandidates(
        uniqueElements(paginationRoots.flatMap((root) => $$(GENERIC_SELECTOR, root))),
        true
      );
      if (scoped.prev || scoped.next) return scoped;
    }
    return scanGenericCandidates(uniqueElements($$(GENERIC_SELECTOR)), false);
  }

  function normalizedMissAvPathParts() {
    if (!/(^|\.)missav\.[a-z0-9-]+$/i.test(location.hostname)) return null;
    let parts;
    try {
      parts = decodeURIComponent(location.pathname).split("/").filter(Boolean);
    } catch (_) {
      parts = location.pathname.split("/").filter(Boolean);
    }
    // MissAV 路径可能带可变线路前缀和语言前缀，例如 /dm74/cn/…。
    if (/^dm\d+$/i.test(parts[0] || "")) parts.shift();
    if (/^[a-z]{2}$/i.test(parts[0] || "")) parts.shift();
    return parts;
  }

  function isMissAvVideoPage() {
    const parts = normalizedMissAvPathParts();
    if (!parts || parts.length !== 1) return false;
    // 视频详情页最后只剩番号；要求同时含拉丁字母和数字，兼容 KIBD-310、FC2-PPV-123、300MIUM-123。
    return /^(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(parts[0]);
  }

  function isMissAvFirstSearchPage() {
    const parts = normalizedMissAvPathParts();
    if (!parts || parts[0]?.toLowerCase() !== "search" || parts.length < 2) return false;
    const page = parseInt(new URL(location.href).searchParams.get("page") || "1", 10);
    return !Number.isFinite(page) || page <= 1;
  }

  function isEpornerNonPagedPage() {
    if (!/(^|\.)eporner\.com$/i.test(location.hostname)) return false;
    const path = location.pathname.replace(/\/{2,}/g, "/");
    // 已确认根首页和 /video-…/ 视频详情页都不属于网页分页界面。
    return path === "/" || /^\/video-[^/]+(?:\/|$)/i.test(path);
  }

  function isSpankBangVideoPage() {
    return /(^|\.)spankbang\.com$/i.test(location.hostname) &&
      /^\/[a-z0-9]+\/video\/[^/]+\/?$/i.test(location.pathname);
  }

  function isSpankBangFirstListPage() {
    if (!/(^|\.)spankbang\.com$/i.test(location.hostname)) return false;
    // 列表首页格式：/<列表ID>/playlist/<名称>/ 或 /s/<搜索词>/；额外路径段通常表示后续页。
    const isPlaylist = /^\/[a-z0-9]+\/playlist\/[^/]+\/?$/i.test(location.pathname);
    const isSearch = /^\/s\/[^/]+\/?$/i.test(location.pathname);
    if (!isPlaylist && !isSearch) return false;
    const page = parseInt(pageFromUrl() || "1", 10);
    return !Number.isFinite(page) || page <= 1;
  }

  function isXVideosFirstHomePage() {
    return /(^|\.)xvideos\.com$/i.test(location.hostname) &&
      location.pathname === "/" &&
      !pageFromUrl();
  }

  // 只处理已经确认的站点边界：
  // 1. NodeSeek 和 XVideos 根首页是第 1 页，不能出现“上一页”；
  // 2. MissAV 视频详情页不分页；搜索第 1 页不能出现“上一页”；
  // 3. Eporner 根首页和视频详情页不分页；
  // 4. SpankBang 视频详情页不分页；播放列表和搜索结果第 1 页不能出现“上一页”。
  function directionBlockedBySite(direction) {
    const nodeSeekFirstPage = direction === "prev" &&
      /(^|\.)nodeseek\.com$/i.test(location.hostname) &&
      location.pathname === "/" &&
      !pageFromUrl();
    if (nodeSeekFirstPage) return true;
    if (isMissAvVideoPage() || isEpornerNonPagedPage() || isSpankBangVideoPage()) return true;
    return direction === "prev" && (isXVideosFirstHomePage() || isMissAvFirstSearchPage() || isSpankBangFirstListPage());
  }

  function findCandidate(direction, numericPager = null, generic = null) {
    if (directionBlockedBySite(direction)) return null;

    const byRel = safeCall(`rel ${direction} 识别失败`, () => findByRel(direction), null);
    if (byRel) return byRel;

    if (numericPager?.[direction]) return numericPager[direction];

    const scan = generic || safeCall("通用候选扫描失败", findGenericCandidates, null);
    return scan?.[direction] || null;
  }

  // 一次性算出两个方向：先用 rel 与数字分页，只有仍有方向缺失时才扫描通用候选。
  function findBothCandidates(numericPager) {
    const blockPrev = directionBlockedBySite("prev");
    const blockNext = directionBlockedBySite("next");
    if (blockPrev && blockNext) return { prev: null, next: null };
    const prevDirect = blockPrev ? null : (safeCall("rel prev 识别失败", () => findByRel("prev"), null) || numericPager?.prev || null);
    const nextDirect = blockNext ? null : (safeCall("rel next 识别失败", () => findByRel("next"), null) || numericPager?.next || null);
    if ((blockPrev || prevDirect) && (blockNext || nextDirect)) return { prev: prevDirect, next: nextDirect };

    const generic = safeCall("通用候选扫描失败", findGenericCandidates, null);
    return {
      prev: blockPrev ? null : (prevDirect || generic?.prev || null),
      next: blockNext ? null : (nextDirect || generic?.next || null),
    };
  }

  // 只解析通用且有明确分页语义的 URL，绝不把普通路径末尾数字当成页码。
  function pageFromUrl(urlLike = location.href) {
    let url;
    try {
      url = new URL(urlLike, location.href);
    } catch (_) {
      return "";
    }
    for (const key of PAGE_QUERY_KEYS) {
      const value = url.searchParams.get(key);
      if (/^\d{1,5}$/.test(value || "")) return String(parseInt(value, 10));
    }
    const pathMatch = url.pathname.match(/(?:page|pg|list)[/_-]?(\d{1,5})(?:\/|$|\.html?$)/i) ||
      url.pathname.match(/\bp[/_-](\d{1,4})(?:\/|$|\.html?$)/i);
    return pathMatch ? String(parseInt(pathMatch[1], 10)) : "";
  }

  function numericText(el) {
    const dataPage = String(el?.getAttribute?.("data-page") || el?.getAttribute?.("data-page-number") || "").trim();
    if (/^0*\d{1,5}$/.test(dataPage)) return String(parseInt(dataPage, 10));
    const text = String(el?.value || el?.textContent || "").trim();
    const match = text.match(/^0*(\d{1,5})$/);
    return match ? String(parseInt(match[1], 10)) : "";
  }

  function hardNavigate(url) {
    if (!url || STATE.navigating) return;
    let target;
    try { target = new URL(url, location.href).href; } catch (_) { return; }
    if (!/^https?:/i.test(target)) return;
    STATE.navigating = true;
    window.location.assign(target);
  }

  function navigateDirection(direction) {
    if (STATE.navigating) return;
    // SPA 或预览 DOM 变化可能让旧候选短暂留在缓存中；执行前再次应用站点边界，
    // 视频详情页即使按钮状态尚未来得及刷新，也绝不能导航到推荐视频。
    if (directionBlockedBySite(direction)) {
      STATE[direction] = null;
      STATE.candidateEpoch = -1;
      const button = document.getElementById(SCRIPT_ID)?.querySelector?.(`.${direction}`);
      if (button) button.disabled = true;
      return;
    }
    // 点击时重新确认数字分页快照并传给统一候选识别，避免无 class 数字分页丢失，
    // 也避免通用评分把分页区中的任意数字链接错当成相邻页。
    // 快照仍然有效时直接复用，不重复扫描全页。
    const numericPager = detectNumericPagerCached();
    const cached = STATE.candidateEpoch === STATE.domEpoch ? STATE[direction] : null;
    const candidate = (cached instanceof Element && cached.isConnected)
      ? cached
      : safeCall(`${direction} 点击前识别失败`, () => findCandidate(direction, numericPager), null);
    STATE[direction] = candidate;
    if (candidate) {
      clickOrNavigate(candidate);
      return;
    }
    requestRefresh(REFRESH_CONTENT, 0);
  }

  function clickOrNavigate(el) {
    if (!el || STATE.navigating) return;
    if (el.__paginationElement) return clickOrNavigate(el.__paginationElement);
    if (el.__paginationUrl) return hardNavigate(el.__paginationUrl);
    // 与识别阶段一致：付费/登录/下载黑名单只对分页容器外的元素生效。
    const blocked = (target) => Boolean(target) && !paginationContainer(target) && deniedPaginationCandidate(target);
    if (!(el instanceof Element) || isOwnUiElement(el) || isCoverPreviewContext(el) || blocked(el)) return;
    const link = el.tagName === "A" || el.tagName === "LINK" ? el : el.closest("a[href]");
    const clickTarget = link || el;
    if (!(clickTarget instanceof HTMLElement) || blocked(link)) return;
    let targetUrl = "";
    try { targetUrl = link?.href ? new URL(link.href, location.href).href : ""; } catch (_) {}
    const canFallback = Boolean(targetUrl && /^https?:/i.test(targetUrl) && (!link.target || link.target.toLowerCase() === "_self"));
    if (!link) {
      HTMLElement.prototype.click.call(clickTarget);
      scheduleEventUpdate();
      return;
    }
    const startUrl = location.href;
    const targetContext = paginationContainer(link) || link.parentElement;
    let settled = false;
    let timeoutTimer = null;
    let pollTimer = null;
    const finish = (fallback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(pollTimer);
      observer?.disconnect();
      STATE.navigating = false;
      if (fallback) {
        hardNavigate(targetUrl);
        return;
      }
      invalidatePagerCache();
      scheduleEventUpdate();
    };
    // 只要分页区 DOM 或 URL 已发生变化就立即收尾，不再硬等满 800ms；
    // 两者都没动静时才在超时后回退到硬跳转。
    const observer = targetContext ? new MutationObserver(() => finish(false)) : null;
    observer?.observe(targetContext, { subtree: true, childList: true, characterData: true, attributes: true });
    STATE.navigating = true;
    try { HTMLElement.prototype.click.call(clickTarget); }
    catch (error) {
      observer?.disconnect();
      STATE.navigating = false;
      log("原生点击分页元素失败", error);
      return;
    }
    pollTimer = setInterval(() => {
      if (location.href !== startUrl || !link.isConnected) finish(false);
    }, 60);
    timeoutTimer = setTimeout(() => {
      finish(location.href === startUrl && link.isConnected && canFallback);
    }, 800);
  }

  function applyPosition(box) {
    if (!box?.isConnected) return;
    box.style.right = `${DEFAULT_RIGHT_GAP}px`;
    box.style.bottom = `${DEFAULT_BOTTOM_GAP}px`;
    box.style.left = "auto";
    box.style.top = "auto";
  }

  function addStyles() {
    const existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle === STATE.styleElement && STATE.styleElement?.isConnected) return;
    existingStyle?.remove?.();
    if (STATE.styleElement && STATE.styleElement !== existingStyle) STATE.styleElement.remove?.();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${SCRIPT_ID} {
        --qpn-text: rgba(28,28,30,.82);
        --qpn-bg: #F2F2F7;
        --qpn-separator: rgba(60,60,67,.16);
        box-sizing: border-box;
        position: fixed;
        right: ${DEFAULT_RIGHT_GAP}px;
        bottom: ${DEFAULT_BOTTOM_GAP}px;
        z-index: 2147483647;
        width: ${WIDTH}px;
        height: ${ITEM_SIZE}px;
        display: flex;
        align-items: center;
        overflow: hidden;
        color: var(--qpn-text);
        background: var(--qpn-bg);
        border: 0;
        border-radius: 999px;
        box-shadow: inset 0 0 0 .5px var(--qpn-separator);
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        transform: translate3d(0,0,0);
      }
      #${SCRIPT_ID} button {
        box-sizing: border-box;
        position: relative;
        width: ${ITEM_SIZE}px;
        min-width: ${ITEM_SIZE}px;
        height: ${ITEM_SIZE}px;
        margin: 0;
        padding: 0;
        border: 0;
        color: inherit;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      #${SCRIPT_ID} button + button::before {
        content: "";
        position: absolute;
        left: 0;
        top: 7px;
        bottom: 7px;
        width: 1px;
        background: var(--qpn-separator);
        pointer-events: none;
      }
      #${SCRIPT_ID} button:active:not(:disabled) { background: rgba(118,118,128,.12); }
      #${SCRIPT_ID} button:disabled { opacity: .28; cursor: default; }
      #${SCRIPT_ID} svg { width: 22px; height: 22px; display: block; pointer-events: none; }
      @media (prefers-color-scheme: dark) {
        #${SCRIPT_ID} {
          --qpn-text: rgba(255,255,255,.94);
          --qpn-bg: #2C2C2E;
          --qpn-separator: rgba(255,255,255,.16);
        }
      }
    `;
    STATE.styleElement = style;
    document.documentElement.appendChild(style);
  }

  function absorbEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function isolateUi(root) {
    ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "mousedown", "mouseup", "click"].forEach((type) => {
      root.addEventListener(type, absorbEvent, { passive: false });
    });
  }

  function bindAction(button, direction) {
    let lastRun = 0;
    const run = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (button.disabled) return;
      const now = Date.now();
      if (now - lastRun < 450) return;
      lastRun = now;
      navigateDirection(direction);
    };
    button.addEventListener("pointerup", run, { passive: false });
    button.addEventListener("touchend", run, { passive: false });
    button.addEventListener("click", run, { passive: false });
  }

  function createToolbar() {
    addStyles();
    let box = document.getElementById(SCRIPT_ID);
    if (
      box &&
      box === STATE.toolbar &&
      box.isConnected &&
      box.querySelector(".prev") === STATE.prevButton &&
      box.querySelector(".next") === STATE.nextButton
    ) return box;
    box?.remove();
    if (STATE.toolbar && STATE.toolbar !== box) STATE.toolbar.remove?.();
    box = document.createElement("div");
    box.id = SCRIPT_ID;
    box.setAttribute("role", "toolbar");
    box.setAttribute("aria-label", "上一页下一页");
    box.innerHTML = `
      <button class="prev" type="button" title="上一页" aria-label="上一页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
      </button>
      <button class="next" type="button" title="下一页" aria-label="下一页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>
      </button>`;
    isolateUi(box);
    (document.body || document.documentElement).appendChild(box);
    const prevButton = box.querySelector(".prev");
    const nextButton = box.querySelector(".next");
    bindAction(prevButton, "prev");
    bindAction(nextButton, "next");
    STATE.toolbar = box;
    STATE.prevButton = prevButton;
    STATE.nextButton = nextButton;
    applyPosition(box);
    return box;
  }

  function ensureToolbar() {
    if (!document.getElementById(STYLE_ID)) addStyles();
    const box = document.getElementById(SCRIPT_ID);
    if (
      !box ||
      box !== STATE.toolbar ||
      !box.isConnected ||
      document.getElementById(STYLE_ID) !== STATE.styleElement ||
      !STATE.styleElement?.isConnected ||
      box.querySelector(".prev") !== STATE.prevButton ||
      box.querySelector(".next") !== STATE.nextButton
    ) {
      box?.remove();
      return createToolbar();
    }
    const parent = document.body || document.documentElement;
    if (parent && box.parentNode !== parent) parent.appendChild(box);
    return box;
  }

  async function updateToolbar() {
    if (STATE.navigating) return;
    if (STATE.updateInFlight) {
      STATE.updateDirty = true;
      return;
    }
    STATE.updateInFlight = true;
    try {
      const numericPager = detectNumericPagerCached();
      observePagerRoot(numericPager?.root || null);
      const candidates = findBothCandidates(numericPager);
      STATE.prev = candidates.prev;
      STATE.next = candidates.next;
      STATE.candidateEpoch = STATE.domEpoch;
      const box = ensureToolbar();
      if (!box) return;
      STATE.prevButton.disabled = !STATE.prev;
      STATE.nextButton.disabled = !STATE.next;
      if (!STATE.prev && !STATE.next && !STATE.hydrationRetried && !STATE.hydrationTimer) {
        STATE.hydrationTimer = setTimeout(() => {
          STATE.hydrationTimer = null;
          STATE.hydrationRetried = true;
          requestRefresh(REFRESH_CONTENT, 0);
        }, 1200);
      } else if (STATE.prev || STATE.next) {
        clearTimeout(STATE.hydrationTimer);
        STATE.hydrationTimer = null;
      }
      applyPosition(box);
    } finally {
      STATE.updateInFlight = false;
      if (STATE.updateDirty) {
        STATE.updateDirty = false;
        scheduleUpdate(0);
      }
    }
  }

  function cancelIdleUpdate() {
    if (STATE.idleHandle == null) return;
    if (STATE.idleUsesRequestCallback && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(STATE.idleHandle);
    } else {
      clearTimeout(STATE.idleHandle);
    }
    STATE.idleHandle = null;
    STATE.idleUsesRequestCallback = false;
  }

  function runWhenIdle(fn, timeout = 800) {
    cancelIdleUpdate();
    const run = () => {
      STATE.idleHandle = null;
      STATE.idleUsesRequestCallback = false;
      fn();
    };
    if (typeof requestIdleCallback === "function") {
      STATE.idleUsesRequestCallback = true;
      STATE.idleHandle = requestIdleCallback(run, { timeout });
    } else {
      STATE.idleHandle = setTimeout(run, 1);
    }
  }

  function scheduleUpdate(delay = 180) {
    clearTimeout(STATE.updateTimer);
    if (document.hidden) {
      cancelIdleUpdate();
      return;
    }
    // 已进入 idle 阶段的任务保留其 800ms 最迟执行保证；最新 DOM 会在执行时读取。
    if (STATE.idleHandle != null) return;
    STATE.updateTimer = setTimeout(() => {
      STATE.updateTimer = null;
      runWhenIdle(() => { if (!document.hidden) void updateToolbar(); }, 800);
    }, delay);
  }

  function scheduleEventUpdate() {
    requestRefresh(REFRESH_CONTENT, 0);
  }

  function elementHasPaginationSignal(el) {
    if (!(el instanceof Element)) return false;
    if (el.matches?.(PAGINATION_CONTAINER_SELECTOR) || paginationContainer(el)) return true;
    if (el.matches?.('[rel~="next"], [rel~="prev"], [aria-current="page"], [data-page], [data-page-number], [class*="next" i], [class*="prev" i]')) return true;
    if (el.matches?.('a, button, [role="button"]')) {
      const text = normalizeText(el);
      return /^\s*0*\d{1,5}\s*$/.test(text) || /\bnext\b|\bprev(?:ious)?\b|下一页|上一页|[›»→‹«←]/i.test(text);
    }
    return false;
  }


  function mutationTouchesRelevantUi(mutation) {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (target?.closest?.(`#${SCRIPT_ID}`) || target?.id === STYLE_ID) return false;
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
      for (const node of list) {
        if (!(node instanceof Element)) continue;
        if (node.id === SCRIPT_ID || node.id === STYLE_ID || node.tagName === "HTML" || node.tagName === "BODY" || node.tagName === "HEAD") return true;
        if (elementHasPaginationSignal(node)) return true;
        // 无限滚动站点每批新增节点可能上千，这里只看前 80 个交互元素并提前退出。
        const nodes = node.querySelectorAll?.('a, button, [role="button"], [rel~="next"], [rel~="prev"], [data-page], [data-page-number], [aria-current="page"]');
        if (!nodes) continue;
        const limit = Math.min(nodes.length, 80);
        for (let i = 0; i < limit; i++) {
          if (elementHasPaginationSignal(nodes[i])) return true;
        }
      }
    }
    return false;
  }

  const REFRESH_STRUCTURE = 1;
  const REFRESH_CONTENT = 2;
  const REFRESH_LAYOUT = 4;
  const REFRESH_FULL = REFRESH_STRUCTURE | REFRESH_CONTENT | REFRESH_LAYOUT;
  function cancelPendingRefreshSchedule() {
    STATE.refreshToken += 1;
    if (STATE.refreshFrame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(STATE.refreshFrame);
    if (STATE.refreshFallbackTimer != null) clearTimeout(STATE.refreshFallbackTimer);
    STATE.refreshFrame = null;
    STATE.refreshFallbackTimer = null;
    STATE.refreshScheduled = false;
  }

  function requestRefresh(flags = REFRESH_FULL, contentDelay = 0) {
    STATE.pendingRefreshFlags |= flags;
    if (flags & REFRESH_CONTENT) STATE.contentDelay = Math.min(STATE.contentDelay, Math.max(0, contentDelay));
    if ((document.hidden && INSTANCE.phase !== "starting") || STATE.refreshScheduled) return;

    STATE.refreshScheduled = true;
    const token = ++STATE.refreshToken;
    let completed = false;
    const run = () => {
      if (completed || token !== STATE.refreshToken) return;
      completed = true;
      if (STATE.refreshFrame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(STATE.refreshFrame);
      if (STATE.refreshFallbackTimer != null) clearTimeout(STATE.refreshFallbackTimer);
      STATE.refreshFrame = null;
      STATE.refreshFallbackTimer = null;
      STATE.refreshScheduled = false;
      const currentFlags = STATE.pendingRefreshFlags;
      const currentContentDelay = Number.isFinite(STATE.contentDelay) ? STATE.contentDelay : 0;
      STATE.pendingRefreshFlags = 0;
      STATE.contentDelay = Infinity;
      const root = document.documentElement || document.body;
      if (!root) {
        STATE.pendingRefreshFlags |= REFRESH_FULL;
        STATE.contentDelay = Math.min(STATE.contentDelay, 0);
        return;
      }
      try {
        if (currentFlags & REFRESH_STRUCTURE) {
          STATE.navigating = false;
          installLifecycleListenersOnce();
          installSharedHistoryHook();
          ensureToolbar();
          ensureDocumentObserver();
        }
        if (currentFlags & REFRESH_CONTENT) scheduleUpdate(currentContentDelay);
        if (currentFlags & REFRESH_LAYOUT) {
          const box = document.getElementById(SCRIPT_ID);
          if (box) applyPosition(box);
        }
        STATE.initialized = true;
        INSTANCE.phase = "running";
      } catch (error) {
        STATE.initialized = false;
        INSTANCE.phase = "failed";
        STATE.pendingRefreshFlags |= REFRESH_FULL;
        STATE.contentDelay = Math.min(STATE.contentDelay, 0);
        log("刷新恢复中", error);
      }
    };

    // 与其他悬浮按钮一致，优先在下一帧完成结构创建；额外保留 240ms 定时兜底，
    // 防止 Safari 预渲染、后台恢复或快速切页时 requestAnimationFrame 长期不回调，
    // 导致 refreshScheduled 永久卡住、工具栏始终不出现。
    if (typeof requestAnimationFrame === "function") {
      STATE.refreshFrame = requestAnimationFrame(run);
      STATE.refreshFallbackTimer = setTimeout(run, 240);
    } else {
      STATE.refreshFallbackTimer = setTimeout(run, 16);
    }
  }

  function installSharedHistoryHook() {
    const marker = window[SHARED_HISTORY_HOOK_KEY];
    const dispatch = (kind) => {
      const shared = window[SHARED_HISTORY_HOOK_KEY];
      if (shared) shared.sequence = Number(shared.sequence || 0) + 1;
      window.dispatchEvent(new CustomEvent(SHARED_URL_CHANGE_EVENT, { detail: { kind, href: location.href } }));
    };
    const wrappersValid = ["pushState", "replaceState"].every((name) =>
      typeof history[name] === "function" && history[name] === marker?.wrappers?.[name] && history[name].__urlChangeEvent === SHARED_URL_CHANGE_EVENT
    );
    if (marker?.eventName === SHARED_URL_CHANGE_EVENT && wrappersValid) return;
    const wrappers = {};
    ["pushState", "replaceState"].forEach((name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      const wrapped = function () {
        const sequence = Number(window[SHARED_HISTORY_HOOK_KEY]?.sequence || 0);
        const result = original.apply(this, arguments);
        if (Number(window[SHARED_HISTORY_HOOK_KEY]?.sequence || 0) === sequence) dispatch(name);
        return result;
      };
      try { Object.defineProperty(wrapped, "__urlChangeEvent", { value: SHARED_URL_CHANGE_EVENT }); } catch (_) {}
      try { history[name] = wrapped; } catch (_) {}
      wrappers[name] = history[name] === wrapped ? wrapped : history[name];
    });
    const handlers = marker?.handlers || {
      popstate: () => dispatch("popstate"),
      hashchange: () => dispatch("hashchange"),
    };
    if (!marker?.handlers) {
      window.addEventListener("popstate", handlers.popstate);
      window.addEventListener("hashchange", handlers.hashchange);
    }
    try { window[SHARED_HISTORY_HOOK_KEY] = { version: 2, eventName: SHARED_URL_CHANGE_EVENT, wrappers, handlers, sequence: Number(marker?.sequence || 0) }; } catch (_) {}
  }

  // 节点存在不等于真的可见：站点样式可能把它压成零尺寸或隐藏。
  function elementVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function toolbarPresent() {
    const box = document.getElementById(SCRIPT_ID);
    if (!box || box !== STATE.toolbar) return false;
    if (box.querySelector(".prev") !== STATE.prevButton || box.querySelector(".next") !== STATE.nextButton) return false;
    return elementVisible(box);
  }


  function recoverRefresh() {
    invalidatePagerCache();
    cancelPendingRefreshSchedule();
    requestRefresh(REFRESH_FULL, 0);
  }

  // 页面恢复时按事件立即刷新；常驻 MutationObserver 持续负责结构自愈，
  // 不使用轮询或有限次数的延迟重试。
  function scheduleWakeRecovery() {
    if (!document.hidden) recoverRefresh();
  }

  function installLifecycleListenersOnce() {
    if (STATE.listenersInstalled) return;
    STATE.listenersInstalled = true;
    window.addEventListener(SHARED_URL_CHANGE_EVENT, () => {
      STATE.navigating = false;
      STATE.hydrationRetried = false;
      invalidatePagerCache();
      clearTimeout(STATE.hydrationTimer);
      STATE.hydrationTimer = null;
      scheduleEventUpdate();
    });
    window.addEventListener("pageshow", scheduleWakeRecovery);
    window.addEventListener("focus", scheduleWakeRecovery);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleWakeRecovery();
    });
  }

  function ensureDocumentObserver() {
    if (STATE.observer) return;
    STATE.observer = new MutationObserver((mutations) => {
      const currentBox = document.getElementById(SCRIPT_ID);
      const toolbarBroken = !currentBox || currentBox !== STATE.toolbar || currentBox.querySelector(".prev") !== STATE.prevButton || currentBox.querySelector(".next") !== STATE.nextButton;
      if (toolbarBroken || document.getElementById(STYLE_ID) !== STATE.styleElement || !STATE.styleElement?.isConnected) {
        requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT, 0);
        return;
      }
      // 先过滤无关 DOM；只有确实触及分页线索的批次才进入节流与补扫。
      if (!mutations.some(mutationTouchesRelevantUi)) return;
      const now = Date.now();
      if (now - STATE.mutationScanAt < 200) {
        if (!STATE.mutationCatchupTimer) {
          STATE.mutationCatchupTimer = setTimeout(() => {
            STATE.mutationCatchupTimer = null;
            STATE.mutationScanAt = Date.now();
            invalidatePagerCache();
            requestRefresh(REFRESH_CONTENT, 0);
          }, 260);
        }
        return;
      }
      STATE.mutationScanAt = now;
      invalidatePagerCache();
      requestRefresh(REFRESH_CONTENT, 120);
    });
    STATE.observer.observe(document, { subtree: true, childList: true });
  }

  // resume 必须同步给出真实结果：若交给异步调度再返回 false，
  // 新注入的实例会与仍在监听的旧实例同时重建工具栏，互相抢节点。
  function resume() {
    invalidatePagerCache();
    cancelPendingRefreshSchedule();
    STATE.pendingRefreshFlags = 0;
    try {
      STATE.navigating = false;
      installLifecycleListenersOnce();
      installSharedHistoryHook();
      const box = ensureToolbar();
      ensureDocumentObserver();
      if (box) applyPosition(box);
      STATE.initialized = true;
      INSTANCE.phase = "running";
    } catch (error) {
      INSTANCE.phase = "failed";
      log("重注入恢复失败", error);
      return false;
    }
    requestRefresh(REFRESH_CONTENT, 0);
    return toolbarPresent();
  }

  function init() {
    requestRefresh(REFRESH_FULL, 0);
  }

  INSTANCE.resume = resume;
  installLifecycleListenersOnce();
  init();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", recoverRefresh, { once: true });
  if (document.readyState !== "complete") window.addEventListener("load", recoverRefresh, { once: true });
})();
