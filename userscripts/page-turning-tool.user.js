// ==UserScript==
// @name         翻页工具
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.3.2
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/page-turning-tool.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/page-turning-tool.user.js
// @description  自动识别网页上一页和下一页，并在悬浮工具栏右侧显示独立翻页按钮。
// @author       Scripting Agent
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-start
// @grant        GM.log
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__pageTurningToolInstanceV1__";
  const previousInstance = document[INSTANCE_KEY];
  if (previousInstance?.resume) {
    previousInstance.resume("reinjected");
    return;
  }
  const INSTANCE = { phase: "starting", resume: null };
  document[INSTANCE_KEY] = INSTANCE;

  const SCRIPT_ID = "floating-page-navigation";
  const STYLE_ID = `${SCRIPT_ID}-style`;
  const BASE_TOOLBAR_ID = "universal-pagination-floating-menu";
  const VIDEO_FULLSCREEN_ID = "video-fullscreen";
  const ITEM_SIZE = /(^|\.)nodeseek\.com$/i.test(location.hostname) ? 32 : 40;
  const CONNECT_OVERLAP = 1;
  const WIDTH = ITEM_SIZE * 2;
  const DEFAULT_RIGHT_GAP = 16;
  const DEFAULT_BOTTOM_GAP = 28;
  const SHARED_URL_CHANGE_EVENT = "scripts:urlchange";
  const SHARED_HISTORY_HOOK_KEY = "__sharedHistoryHookV1__";
  const STATE = {
    prev: null,
    next: null,
    numericPager: null,
    navigating: false,
    initialized: false,
    observer: null,
    toolbar: null,
    styleElement: null,
    prevButton: null,
    nextButton: null,
    retryTimer: null,
    refreshRetryCount: 0,
    listenersInstalled: false,
    pagerObserver: null,
    observedPagerRoot: null,
    updateTimer: null,
    idleHandle: null,
    idleUsesRequestCallback: false,
    updateInFlight: false,
    updateDirty: false,
    toolbarObserver: null,
    toolbarResizeObserver: null,
    observedToolbar: null,
    xvideosNormalizeTimer: null,
    hydrationTimer: null,
    hydrationRetried: false,
    pendingRefreshFlags: 0,
    refreshScheduled: false,
    contentDelay: Infinity,
    domEpoch: 0,
    pagerCache: null,
    candidateEpoch: -1,
    mutationScanAt: 0,
    mutationCatchupTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // hostname 在同一个文档内不会变化，站点判定结果只算一次，避免每轮刷新重复跑十几次正则。
  const HOST_MATCH_CACHE = new Map();
  function hostIs(pattern) {
    let matched = HOST_MATCH_CACHE.get(pattern);
    if (matched === undefined) {
      matched = pattern.test(location.hostname);
      HOST_MATCH_CACHE.set(pattern, matched);
    }
    return matched;
  }
  const HOST_XVIDEOS = /(^|\.)xvideos\.com$/i;
  const HOST_JABLE = /(^|\.)jable\.tv$/i;
  const HOST_OHENTAI = /(^|\.)ohentai\.org$/i;
  const HOST_RULE34 = /(^|\.)rule34video\.com$/i;
  const HOST_MISSAV = /(^|\.)missav\.[a-z0-9-]+$/i;
  const HOST_EPORNER = /(^|\.)eporner\.com$/i;
  const HOST_FUTAPO2 = /(^|\.)futapo2\.com$/i;
  const HOST_NODESEEK = /(^|\.)nodeseek\.com$/i;
  const HOST_WHOSTV = /(^|\.)whos\.tv$/i;

  function log(...args) {
    try {
      if (typeof GM !== "undefined" && GM.log) GM.log("[翻页菜单]", ...args);
      else console.log("[翻页菜单]", ...args);
    } catch (_) {}
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function disabled(el) {
    if (!el) return true;
    const anchorWithoutHref = el.tagName === "A" && !el.getAttribute("href") && !el.onclick;
    return Boolean(
      el.disabled ||
      el.getAttribute("aria-disabled") === "true" ||
      /(^|\s)(disabled|disable|unavailable|inactive)(\s|$)/i.test(el.className || "") ||
      (anchorWithoutHref && !el.hasAttribute("data-page") && !paginationContainer(el))
    );
  }

  function labelledByText(el) {
    const ids = String(el?.getAttribute?.("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
  }

  function normalizeText(el) {
    return [
      el.innerText,
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
      el?.closest?.(`#${SCRIPT_ID}, #${BASE_TOOLBAR_ID}, #${VIDEO_FULLSCREEN_ID}`)
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

  function hasPageUrlEvidence(el, page) {
    const href = el?.href || el?.getAttribute?.("href") || "";
    if (!href || !page) return false;
    try {
      const url = new URL(href, location.href);
      if (!/^https?:$/i.test(url.protocol) || url.origin !== location.origin) return false;
      if (["page", "p", "paged", "pg", "pn", "pageNo", "pageNumber"].some((key) => url.searchParams.get(key) === String(page))) return true;
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
        if (/calendar|datepicker|date-picker|carousel|slider|tabs?|years?|months?/i.test(`${root.className || ""} ${root.id || ""} ${root.getAttribute?.("role") || ""}`)) continue;

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
    return $(`a[rel~="${rel}"]`);
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

  function scanGenericCandidates(elements, inPagination) {
    const result = { prev: null, next: null, prevScore: GENERIC_SCORE_FLOOR, nextScore: GENERIC_SCORE_FLOOR };
    for (const el of elements) {
      if (isOwnUiElement(el)) continue;
      const context = safeCall("候选上下文计算失败", () => ({
        inPagination: inPagination || Boolean(paginationContainer(el)),
        text: normalizeText(el).toLowerCase(),
        href: (el.getAttribute("href") || "").toLowerCase(),
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

  function findCandidate(direction, numericPager = null, generic = null) {
    if (isMissAv()) {
      return safeCall(`MissAV ${direction} 识别失败`, () => findMissAvCandidate(direction), null);
    }

    if (isRule34Video()) {
      const siteCandidate = safeCall(`Rule34 ${direction} 识别失败`, () => findRule34Candidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    if (isEporner()) {
      const siteCandidate = safeCall(`Eporner ${direction} 识别失败`, () => findEpornerCandidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    if (isEpornerVideoPage()) return null;
    if (isFutapo2SingleCollectionPage()) return null;

    if (isJable()) {
      return safeCall(`Jable ${direction} 识别失败`, () => findJableCandidate(direction), null);
    }

    if (isXVideosNewListPage() || isXVideosVideoPage()) {
      return safeCall(`XVideos ${direction} 识别失败`, () => findXVideosCandidate(direction), null);
    }

    if (isXVideos()) {
      const siteCandidate = safeCall(`XVideos ${direction} 识别失败`, () => findXVideosCandidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    if (isOHentai()) {
      return safeCall(`OHentai ${direction} 识别失败`, () => findOHentaiCandidate(direction), null);
    }

    if (isNodeSeek()) {
      const siteCandidate = safeCall(`NodeSeek ${direction} 识别失败`, () => findNodeSeekCandidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    if (isWhosTv()) {
      const siteCandidate = safeCall(`WhosTV ${direction} 识别失败`, () => findWhosTvCandidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    if (isDiscuz()) {
      const siteCandidate = safeCall(`Discuz ${direction} 识别失败`, () => findDiscuzCandidate(direction), null);
      if (siteCandidate) return siteCandidate;
    }

    const byRel = safeCall(`rel ${direction} 识别失败`, () => findByRel(direction), null);
    if (byRel && byRel.href && !disabled(byRel) && (paginationContainer(byRel) || !deniedPaginationCandidate(byRel))) return byRel;

    if (numericPager?.[direction]) return numericPager[direction];

    const scan = generic || safeCall("通用候选扫描失败", findGenericCandidates, null);
    return scan?.[direction] || null;
  }

  // 一次性算出两个方向的候选，通用扫描只跑一遍。
  function findBothCandidates(numericPager) {
    const generic = safeCall("通用候选扫描失败", findGenericCandidates, null);
    return {
      prev: safeCall("上一页识别失败", () => findCandidate("prev", numericPager, generic), null),
      next: safeCall("下一页识别失败", () => findCandidate("next", numericPager, generic), null),
    };
  }

  function pageFromUrl(urlLike = location.href) {
    const url = new URL(urlLike, location.href);
    const xvideosNewPage = getXVideosNewDisplayPage(url.href);
    if (xvideosNewPage) return xvideosNewPage;
    const xvideosSearchPage = getXVideosSearchDisplayPage(url.href);
    if (xvideosSearchPage) return xvideosSearchPage;
    for (const key of ["page", "p", "paged", "pg", "pn", "pageNo", "pageNumber"]) {
      const value = url.searchParams.get(key);
      if (/^\d+$/.test(value || "")) return String(parseInt(value, 10));
    }
    if (/(^|\.)eporner\.com$/i.test(url.hostname)) {
      const playlistPage = getEpornerPlaylistPage(url.href);
      if (playlistPage) return playlistPage;
    }

    // NodeSeek 列表页：/page-2，最后一个数字就是页码。
    if (/(^|\.)nodeseek\.com$/i.test(url.hostname)) {
      const nodeSeekListMatch = url.pathname.match(/^\/page-0*(\d{1,5})(?:\/)?$/i);
      if (nodeSeekListMatch) return String(parseInt(nodeSeekListMatch[1], 10));
      const nodeSeekCategoryMatch = url.pathname.match(/^\/categories\/[^/]+\/page-0*(\d{1,5})(?:\/)?$/i);
      if (nodeSeekCategoryMatch) return String(parseInt(nodeSeekCategoryMatch[1], 10));
    }

    // NodeSeek 帖子分页格式：/post-174345-3，最后一个数字才是页码，
    // 中间的 174345 是帖子 ID，不能误当成页码。
    if (/(^|\.)nodeseek\.com$/i.test(url.hostname)) {
      const nodeSeekPostMatch = url.pathname.match(/^\/post-\d+-0*(\d{1,5})(?:\/)?$/i);
      if (nodeSeekPostMatch) return String(parseInt(nodeSeekPostMatch[1], 10));
    }

    if (isXVideos()) {
      const xvideosPathPage = getXVideosPathPage(urlLike);
      if (xvideosPathPage) return xvideosPathPage;
    }

    // 通用路径页码：要求 page/pg/list 关键字，或 `p` 后带明确分隔符且位数不超过 4，
    // 避免把 /p/1234567 这类文章 ID 误判成页码。
    const pathMatch = url.pathname.match(/(?:page|pg|list)[/_-]?(\d{1,5})(?:\/|$|\.html?$)/i) ||
      url.pathname.match(/\bp[/_-](\d{1,4})(?:\/|$|\.html?$)/i);
    if (pathMatch) return String(parseInt(pathMatch[1], 10));
    return "";
  }

  function isXVideos() {
    return hostIs(HOST_XVIDEOS);
  }

  function isXVideosNewListPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      if (!/(^|\.)xvideos\.com$/i.test(url.hostname)) return false;
      if (/^\/new\/[1-9]\d{0,4}\/?$/i.test(url.pathname)) return true;
      // 根路径同时承载首页和搜索结果。搜索使用 ?k=...&p=N，不能套用首页 /new/N 映射。
      return url.pathname === "/" && !["k", "p", "page"].some((key) => url.searchParams.has(key));
    } catch (_) {
      return false;
    }
  }

  function isXVideosSearchPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      return /(^|\.)xvideos\.com$/i.test(url.hostname) && url.pathname === "/" && url.searchParams.has("k");
    } catch (_) {
      return false;
    }
  }

  function getXVideosSearchDisplayPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      if (!isXVideosSearchPage(url.href)) return "";
      const raw = url.searchParams.get("p");
      if (raw == null || raw === "") return "1";
      return /^\d{1,5}$/.test(raw) ? String(parseInt(raw, 10) + 1) : "";
    } catch (_) {
      return "";
    }
  }

  function makeXVideosSearchPageUrl(displayPage) {
    displayPage = parseInt(displayPage, 10);
    if (!isXVideosSearchPage() || !Number.isFinite(displayPage) || displayPage < 1) return "";
    const url = new URL(location.href);
    if (displayPage === 1) url.searchParams.delete("p");
    else url.searchParams.set("p", String(displayPage - 1));
    url.searchParams.delete("page");
    if (/^#_tabVideos(?:,page-\d+)?$/i.test(url.hash)) url.hash = "";
    return url.href;
  }

  function isXVideosVideoPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      return /(^|\.)xvideos\.com$/i.test(url.hostname) && /^\/video\./i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function getXVideosNewDisplayPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      if (!/(^|\.)xvideos\.com$/i.test(url.hostname)) return "";
      if (url.pathname === "/") return isXVideosNewListPage(url.href) ? "1" : "";
      const match = url.pathname.match(/^\/new\/([1-9]\d{0,4})\/?$/i);
      return match ? String(parseInt(match[1], 10) + 1) : "";
    } catch (_) {
      return "";
    }
  }

  function makeXVideosNewPageUrl(displayPage) {
    displayPage = parseInt(displayPage, 10);
    if (!Number.isFinite(displayPage) || displayPage < 1) return "";
    const url = new URL(location.href);
    url.pathname = displayPage === 1 ? "/" : `/new/${displayPage - 1}`;
    url.searchParams.delete("page");
    if (/^#_tabVideos(?:,page-\d+)?$/i.test(url.hash)) url.hash = "";
    return url.href;
  }

  function isJable() {
    return hostIs(HOST_JABLE);
  }

  function getJablePathPage(urlLike = location.href) {
    if (!isJable()) return "";
    try {
      const url = new URL(urlLike, location.href);
      const match = url.pathname.match(/^(\/(?:tags|categories|models|studios|makers?|latest-updates|new-release|hot|search)(?:\/[^/?#]+){0,4})\/0*(\d{1,5})\/?$/i);
      if (match) return String(parseInt(match[2], 10));
    } catch (_) {}
    return "";
  }

  function getJableCurrentPage() {
    const fromPath = getJablePathPage();
    if (fromPath) return fromPath;
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;
    const active = $('.pagination .active, .pagination .current, nav .active, nav .current, [aria-current="page"]');
    const n = active ? numericText(active) : "";
    if (n) return n;
    if (/^\/(?:tags|categories|models|studios|makers?|latest-updates|new-release|hot|search)(?:\/|$)/i.test(location.pathname)) return "1";
    return "";
  }

  function makeJablePageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    let path = url.pathname || "/";
    path = path.replace(/\/0*\d{1,5}\/?$/i, "/");
    path = path.replace(/\/+$/g, "") + "/";
    if (targetPage > 1) path += `${targetPage}/`;
    url.pathname = path;
    return url.href;
  }

  function findJableCandidate(direction) {
    const current = parseInt(getJableCurrentPage() || "1", 10);
    if (!Number.isFinite(current) || current < 1) return null;
    const target = current + (direction === "next" ? 1 : -1);
    if (target < 1) return null;
    const url = makeJablePageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function isOHentai() {
    return hostIs(HOST_OHENTAI);
  }

  function findOHentaiCandidate(direction) {
    const current = parseInt(pageFromUrl() || getCurrentPage() || "1", 10);
    if (!Number.isFinite(current) || current < 1) return null;
    const target = current + (direction === "next" ? 1 : -1);
    if (target < 1) return null;
    const url = new URL(location.href);
    url.searchParams.set("p", String(target));
    return { __paginationUrl: url.href };
  }

  function makeXVideosDisplayPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return "";
    if (isXVideosNewListPage()) return makeXVideosNewPageUrl(targetPage);
    if (isXVideosSearchPage()) return makeXVideosSearchPageUrl(targetPage);
    const url = new URL(location.href);
    const pathPage = getXVideosPathPage();
    if (pathPage) {
      url.search = "";
      url.hash = "";
      url.pathname = replaceXVideosPathPage(url.pathname, targetPage);
      return url.href;
    }
    // xvideos 地址栏最终正常格式：?page=N#_tabVideos。
    url.searchParams.set("page", String(targetPage));
    url.hash = "_tabVideos";
    return url.href;
  }

  function getXVideosPathPage(urlLike = location.href) {
    if (!isXVideos()) return "";
    try {
      const url = new URL(urlLike, location.href);
      const match = url.pathname.match(/^(\/(?:best-of-[^/]+|new-[^/]+|tags?|channels?|pornstars?|profiles?|c|cat|search)(?:\/[^/?#]+){1,6})\/0*(\d{1,5})\/?$/i);
      if (match) return String(parseInt(match[2], 10));
    } catch (_) {}
    return "";
  }

  function replaceXVideosPathPage(pathname, targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return pathname;
    const clean = String(pathname || "/").replace(/\/+$/g, "");
    if (/^(\/(?:best-of-[^/]+|new-[^/]+|tags?|channels?|pornstars?|profiles?|c|cat|search)(?:\/[^/?#]+){1,6})\/0*\d{1,5}$/i.test(clean)) {
      return clean.replace(/\/0*\d{1,5}$/i, targetPage <= 1 ? "" : `/${targetPage}`);
    }
    return targetPage <= 1 ? clean : `${clean}/${targetPage}`;
  }

  function makeXVideosPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return "";
    if (isXVideosNewListPage()) return makeXVideosNewPageUrl(targetPage);
    if (isXVideosSearchPage()) return makeXVideosSearchPageUrl(targetPage);
    const url = new URL(location.href);
    const pathPage = getXVideosPathPage();
    if (pathPage) {
      url.search = "";
      url.hash = "";
      url.pathname = replaceXVideosPathPage(url.pathname, targetPage);
      return url.href;
    }
    // xvideos 真正触发视频 tab 翻页需要临时 hash page-N；
    // 页面加载完成后会清理成 ?page=N#_tabVideos。
    url.searchParams.set("page", String(targetPage));
    url.hash = `_tabVideos,page-${targetPage}`;
    return url.href;
  }

  function normalizeXVideosHashLater() {
    if (!isXVideos()) return;
    const page = pageFromUrl();
    const legacyHash = /^#_tabVideos(?:,page-\d+)?$/i.test(String(location.hash || ""));
    const legacyQuery = new URL(location.href).searchParams.has("page");
    if (!page || (!legacyHash && !legacyQuery)) return;
    if (!isXVideosNewListPage()) {
      const match = String(location.hash || "").match(/^#_tabVideos,page-(\d+)$/i);
      if (!match || match[1] !== page) return;
    }
    const cleanUrl = makeXVideosDisplayPageUrl(page);
    if (!cleanUrl) return;
    const sourceUrl = location.href;
    clearTimeout(STATE.xvideosNormalizeTimer);
    STATE.xvideosNormalizeTimer = setTimeout(() => {
      STATE.xvideosNormalizeTimer = null;
      try {
        if (location.href === sourceUrl && location.href !== cleanUrl) history.replaceState(history.state, document.title, cleanUrl);
      } catch (_) {}
    }, 1500);
  }

  function findXVideosNewPageLink(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return null;
    let directionalFallback = null;
    for (const el of $$('a[href]')) {
      if (!visible(el) || disabled(el) || deniedPaginationCandidate(el)) continue;
      if (parseInt(getXVideosNewDisplayPage(el.href) || "", 10) !== targetPage) continue;
      if (parseInt(numericText(el) || "", 10) === targetPage) return el;
      if (el.matches(".next-page, .prev-page") || paginationContainer(el)) directionalFallback = directionalFallback || el;
    }
    return directionalFallback;
  }

  function findXVideosCandidate(direction) {
    if (isXVideosVideoPage()) return null;
    if (isXVideosNewListPage()) {
      const current = parseInt(getXVideosNewDisplayPage() || "", 10);
      if (!Number.isFinite(current) || current < 1) return null;
      const target = current + (direction === "next" ? 1 : -1);
      if (target < 1) return null;
      const realLink = findXVideosNewPageLink(target);
      if (realLink) return realLink;
      // 下一页必须由当前 DOM 证明，避免末页继续亮起；较小页已知存在，可安全构造上一页。
      if (direction === "next") return null;
      const url = makeXVideosNewPageUrl(target);
      return url ? { __paginationUrl: url } : null;
    }

    // 其他 XVideos 分类/搜索页仍保留旧 tab 分页，但必须有真实分页证据，不能在详情页盲造地址。
    const pager = detectNumericPagerCached();
    if (pager?.[direction]) return pager[direction];
    const current = parseInt(pageFromUrl() || pager?.currentPage || "", 10);
    if (!Number.isFinite(current) || current < 1) return null;
    const target = current + (direction === "next" ? 1 : -1);
    if (target < 1 || direction === "next") return null;
    const url = makeXVideosPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function isRule34Video() {
    return hostIs(HOST_RULE34);
  }

  function rule34PageFromDataParameters(el) {
    if (!el || !isRule34Video()) return "";
    const raw = el.getAttribute?.("data-parameters") || "";
    const match = raw.match(/(?:^|;)(?:from(?:_[^:;]*)?):0*(\d{1,5})(?:;|$)/i);
    if (!match) return "";
    return String(parseInt(match[1], 10));
  }

  function getRule34AjaxPaginationLinks() {
    if (!isRule34Video()) return [];
    return $$('a[data-action="ajax"][data-parameters]').filter((el) => rule34PageFromDataParameters(el));
  }

  function getRule34VisiblePaginationPage() {
    let best = "";
    let bestBottom = -Infinity;
    for (const el of getRule34AjaxPaginationLinks()) {
      if (!visible(el)) continue;
      const text = (el.textContent || el.innerText || "").trim();
      if (!/^0*\d{1,5}$/.test(text)) continue;
      const page = rule34PageFromDataParameters(el) || numericText(el);
      if (!page) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top >= bestBottom) {
        best = page;
        bestBottom = rect.top;
      }
    }
    return best;
  }

  function findRule34AjaxPageLink(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return null;
    let fallback = null;
    for (const el of getRule34AjaxPaginationLinks()) {
      const page = parseInt(rule34PageFromDataParameters(el) || "", 10);
      if (page !== targetPage) continue;
      if (visible(el)) return el;
      fallback = fallback || el;
    }
    return fallback;
  }

  function isRule34PaginationContainer(el) {
    if (!el || !isRule34Video()) return false;
    if (rule34PageFromDataParameters(el)) return true;
    return Boolean(el.closest?.('nav, .pagination, .pager, [class*="pagination"], [class*="pager"], [class*="pages"], [class*="page-list"], [class*="pagebar"]'));
  }

  function hasRule34PaginationDom() {
    if ($('.pagination, .pager, [class*="pagination"], [class*="pager"], [class*="pages"], [class*="page-list"], [class*="pagebar"]')) return true;
    return $$('a[href], button, [role="button"], [onclick]').some((el) => isRule34PaginationContainer(el) && numericText(el));
  }

  function getRule34PathPage() {
    const path = location.pathname;

    // /tags/37807/ 里的 37807 是标签 ID，不是页码；真正分页通常是 /tags/37807/2/。
    const nestedPage = path.match(/^\/(?:tags|models|channels|sites|categories|search)\/[^/]+\/0*(\d{1,5})\/?$/i);
    if (nestedPage) return String(parseInt(nestedPage[1], 10));

    // rule34video 的普通列表页常见格式：/latest-updates/9/。
    const listPage = path.match(/^\/(?:latest-updates|top-rated|most-popular|private|premium|albums(?:\/(?:top-rated|most-popular|private|premium)?)?)\/0*(\d{1,5})\/?$/i);
    if (listPage) return String(parseInt(listPage[1], 10));

    // 其他末尾数字只有在页面存在真实分页 DOM 时才可视为页码，避免把 ID 误判成页码。
    const genericPage = path.match(/\/0*(\d{1,5})\/?$/);
    if (genericPage && hasRule34PaginationDom()) return String(parseInt(genericPage[1], 10));
    return "";
  }

  function isMissAv() {
    return hostIs(HOST_MISSAV);
  }

  function isEporner() {
    return hostIs(HOST_EPORNER);
  }

  function isFutapo2() {
    return hostIs(HOST_FUTAPO2);
  }

  function isFutapo2SingleCollectionPage() {
    if (!isFutapo2()) return false;
    return /^\/futa-on-futa\/?$/i.test(location.pathname);
  }

  // Discuz! 论坛（含触屏版 mobile=2）：搜索结果 / 版块列表 / 帖子分页。
  // 这些页面的「下一页」DOM 链接在触屏版常是 javascript:; 或缺少 searchid，
  // 直接点会停在原页。改为基于当前 URL 构造翻页地址（保留全部 query 只改 page）。
  function isDiscuz() {
    const path = location.pathname || "";
    if (!/(?:search|forum|home|space|group)\.php$/i.test(path) &&
        !/(?:forum|thread|space|group)-\d+/i.test(path)) {
      return false;
    }
    // 进一步用全局变量 / 典型脚本确认是 Discuz，降低误判。
    try {
      if (typeof window.discuz_uid !== "undefined") return true;
      if (typeof window.STYLEID !== "undefined" || typeof window.SITEURL !== "undefined") return true;
    } catch (_) {}
    // search.php?searchid=... 这类带 Discuz 特征参数的地址也认。
    const search = location.search || "";
    return /[?&](?:searchid|mod|fid|tid|forumlist)=/i.test(search) ||
      /(?:forum|thread|space|group)-\d+/i.test(path);
  }

  // 为 Discuz 构造翻页地址：query 有 page 则改 page；否则 page=1 + 偏移；
  // 静态化地址 thread-TID-PAGE-1.html / forum-FID-PAGE.html 改中间页码段。
  function makeDiscuzPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    if (url.searchParams.has("page")) {
      url.searchParams.set("page", String(targetPage));
      return url.href;
    }
    // thread-12345-3-1.html -> thread-12345-4-1.html（中间段是页码）。
    let m = url.pathname.match(/^(.*\/(?:thread|forum)-\d+-)(\d+)(-\d+\.html?)$/i);
    if (m) {
      url.pathname = `${m[1]}${targetPage}${m[3]}`;
      return url.href;
    }
    // forum-12345-3.html -> forum-12345-4.html。
    m = url.pathname.match(/^(.*\/(?:forum|group)-\d+-)(\d+)(\.html?)$/i);
    if (m) {
      url.pathname = `${m[1]}${targetPage}${m[3]}`;
      return url.href;
    }
    // 其余 .php 列表页：直接补 page 参数。
    url.searchParams.set("page", String(targetPage));
    return url.href;
  }

  function getDiscuzCurrentPage() {
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;
    // thread-12345-3-1.html / forum-12345-3.html 中间段页码。
    let m = location.pathname.match(/^.*\/(?:thread|forum|group)-\d+-(\d+)(?:-\d+)?\.html?$/i);
    if (m) return m[1];
    return "";
  }

  function findDiscuzCandidate(direction) {
    const current = parseInt(getDiscuzCurrentPage() || "1", 10);
    const cur = Number.isFinite(current) ? current : 1;
    const target = cur + (direction === "next" ? 1 : -1);
    if (target < 1) return null;
    // 下一页：需页面存在 Discuz 分页区（.pg/.pgs）或当前不是首页，
    // 避免在单页结果上也亮起“下一页”。
    if (direction === "next") {
      const hasPager = !!$(".pg, .pgs, .pages, [class*=\"pg\"] a");
      const hasNextLink = !!$(".pg .nxt, .pg a.nxt, a.nxt");
      if (!hasPager && !hasNextLink && cur <= 1) return null;
    }
    const url = makeDiscuzPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function isEpornerVideoPage() {
    return isEporner() && /^\/video-[^/]+\//i.test(location.pathname);
  }

  function isEpornerPlaylistPage(urlLike = location.href) {
    if (!isEporner()) return false;
    try {
      const url = new URL(urlLike, location.href);
      return /^\/profile\/[^/]+\/playlist\/[^/]+\/[^/]+(?:\/0*\d{1,5})?\/?$/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function getEpornerPlaylistPage(urlLike = location.href) {
    try {
      const url = new URL(urlLike, location.href);
      if (!/(^|\.)eporner\.com$/i.test(url.hostname)) return "";
      const match = url.pathname.match(/^\/profile\/[^/]+\/playlist\/[^/]+\/[^/]+(?:\/0*(\d{1,5}))?\/?$/i);
      if (!match) return "";
      return match[1] ? String(parseInt(match[1], 10)) : "1";
    } catch (_) {
      return "";
    }
  }

  function makeEpornerPlaylistPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isEpornerPlaylistPage() || !Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    const match = url.pathname.match(/^(\/profile\/[^/]+\/playlist\/[^/]+\/[^/]+)(?:\/0*\d{1,5})?\/?$/i);
    if (!match) return "";
    url.pathname = targetPage === 1 ? `${match[1]}/` : `${match[1]}/${targetPage}/`;
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function findEpornerCandidate(direction) {
    if (!isEporner()) return null;
    if (isEpornerVideoPage()) return null;

    const selector = direction === "next"
      ? '.numlist2 > a.nmnext[href], a[rel~="next"][href]'
      : '.numlist2 > a.nmback[href], a[rel~="prev"][href]';
    for (const el of $$(selector)) {
      if (visible(el) && !disabled(el) && !deniedPaginationCandidate(el)) return el;
    }

    const rel = direction === "next" ? "next" : "prev";
    const headLink = $(`link[rel~="${rel}"][href]`);
    if (headLink?.href && !deniedPaginationCandidate(headLink)) {
      return { __paginationUrl: headLink.href };
    }

    if (!isEpornerPlaylistPage()) return null;
    const current = parseInt(getEpornerCurrentPage() || "1", 10);
    const target = current + (direction === "next" ? 1 : -1);
    if (!Number.isFinite(target) || target < 1) return null;

    // 上一页只要当前页大于 1 就一定存在；下一页必须由站点真实链接证明，
    // 避免在播放列表末页构造一个不存在的地址并跳到 404。
    if (direction === "next") return null;
    const url = makeEpornerPlaylistPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function getEpornerCurrentPage() {
    if (!isEporner()) return "";

    // 播放列表当前页使用 span.nmhere，而不是通用的 active/current 标记。
    // DOM 优先，兼容站点未来局部更新内容但暂未同步地址栏的情况。
    for (const el of $$('.numlist2 > .nmhere, .numlist2 .nmhere')) {
      const page = numericText(el);
      if (page) return page;
    }

    const playlistPage = getEpornerPlaylistPage();
    if (playlistPage) return playlistPage;

    // eporner 的列表页常见格式：/recommendations/2/，这里的末尾数字就是页码。
    // 只对明确的列表路径启用，避免把视频详情页 ID 误判成页码。
    const match = location.pathname.match(/^\/(?:recommendations|videos|cat|category|search|channels?|pornstars?|albums?|photos?|top-rated|most-viewed|latest|newest)\/(?:[^/]+\/)*0*(\d{1,5})\/?$/i);
    if (match) return String(parseInt(match[1], 10));
    return "";
  }

  function normalizeMissAvPath(pathname = location.pathname) {
    let path = decodeURIComponent(pathname || "");
    // MissAV 常见路径：/cn/genres/...；也有 /dm46/cn/genres/... 这类代理/分区前缀。
    path = path.replace(/^\/(?:dm\d+|dm)(?=\/|$)/i, "");
    path = path.replace(/^\/[a-z]{2}(?=\/|$)/i, "");
    return path || "/";
  }

  function isMissAvSavedPage() {
    if (!isMissAv()) return false;
    try {
      const url = new URL(location.href);
      const path = normalizeMissAvPath(url.pathname || "");
      return /^\/saved(?:\/|$)/i.test(path) || /(?:^|[?#&/])saved(?:[/?#&]|$)/i.test(url.href);
    } catch (_) {
      return /missav\.[a-z0-9-]+\/.*saved/i.test(location.href);
    }
  }

  function isMissAvVideoPath(path) {
    const normalized = normalizeMissAvPath(path);
    // 影片详情页通常是 /abc-123、/abc123 这类番号；列表路径不能被 /dm46 前缀误判。
    return /^\/[a-z]{2,10}-?\d+(?:\/|$)/i.test(normalized);
  }

  function isMissAvPaginationPage() {
    if (!isMissAv()) return false;
    if (isMissAvSavedPage()) return true;
    const url = new URL(location.href);
    const path = normalizeMissAvPath(url.pathname);
    // MissAV 移动端/代理路径可能带语言前缀或 /dm46 前缀，例如：
    // /cn/genres/name、/dm46/cn/genres/name、/dm46/cn/saved。
    if (/^\/(saved|search|genre|genres|series|dm|makers?|actress|actresses|tag|tags|release|today|weekly|monthly|new|uncensored|chinese-subtitle)(?:\/|$)/i.test(path)) return true;
    if (url.searchParams.has("page") && !isMissAvVideoPath(url.pathname)) return true;
    return false;
  }

  function getMissAvCurrentPage() {
    if (!isMissAvPaginationPage()) return "";
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;
    for (const el of $$('[aria-current="page"], .active, .current, [class*="active"], [class*="current"]')) {
      const n = numericText(el);
      if (n) return n;
    }
    return "1";
  }

  function getMissAvTotalPages() {
    if (!isMissAvPaginationPage()) return NaN;

    // 常见显示：当前页旁边的“/ 3”。优先从完整正文里提取，
    // 避免需要依赖具体 class（MissAV/Tailwind class 经常变化）。
    const bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
    let best = NaN;
    for (const match of bodyText.matchAll(/\/\s*0*(\d{1,5})(?!\d)/g)) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) best = Number.isFinite(best) ? Math.max(best, n) : n;
    }

    // 同时扫描分页区里的数字按钮，作为没有“/ 总页数”时的保底。
    for (const el of $$('nav, .pagination, .pager, [class*="pagination"], [class*="pager"]')) {
      const text = el.innerText || el.textContent || "";
      for (const match of text.matchAll(/\b0*(\d{1,5})\b/g)) {
        const n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > 0) best = Number.isFinite(best) ? Math.max(best, n) : n;
      }
    }
    return best;
  }

  function hasMissAvDirectionControl(direction) {
    const wordRe = direction === "next" ? /下一[页頁]|下[页頁]|\bnext\b/i : /上一[页頁]|上[页頁]|\bprev(?:ious)?\b/i;
    const arrowRe = direction === "next" ? /^[\s›»→＞>]+$/ : /^[\s‹«←＜<]+$/;
    for (const el of $$('a[href], button, [role="button"], [onclick]')) {
      if (!visible(el) || disabled(el)) continue;
      const text = normalizeText(el);
      if (wordRe.test(text) || arrowRe.test(text)) return true;
    }
    return false;
  }

  function makeMissAvPageUrl(targetPage) {
    if (!isMissAvPaginationPage() || !targetPage || targetPage < 1) return "";
    const url = new URL(location.href);
    url.searchParams.set("page", String(targetPage));
    return url.href;
  }

  function getMissAvSavedCurrentPage() {
    if (!isMissAvSavedPage()) return "";
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;
    const text = document.body ? (document.body.innerText || document.body.textContent || "") : "";
    const m = text.match(/(?:^|\s)0*(\d{1,5})\s*\/\s*0*\d{1,5}(?:\s|$)/);
    if (m) return String(parseInt(m[1], 10));
    return "1";
  }

  function makeMissAvSavedPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isMissAvSavedPage() || !Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/saved";
    url.searchParams.set("page", String(targetPage));
    return url.href;
  }

  function findMissAvSavedCandidate(direction) {
    if (!isMissAvSavedPage()) return null;
    const current = parseInt(getMissAvSavedCurrentPage() || "1", 10);
    const target = current + (direction === "next" ? 1 : -1);
    if (!Number.isFinite(target) || target < 1) return null;

    const total = getMissAvTotalPages();
    if (direction === "next" && Number.isFinite(total) && total > 0 && current >= total) return null;

    // 先用真实“上一頁/下一頁”按钮；没有 href 或识别不到时再构造 URL。
    const wordRe = direction === "next" ? /下一[页頁]|下[页頁]|\bnext\b/i : /上一[页頁]|上[页頁]|\bprev(?:ious)?\b/i;
    for (const el of $$('a[href], button, [role="button"], [onclick]')) {
      if (!visible(el) || disabled(el)) continue;
      if (wordRe.test(normalizeText(el))) return el;
    }

    if (direction === "next" && Number.isFinite(total) && target > total) return null;
    const url = makeMissAvSavedPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function findMissAvCandidate(direction) {
    if (isMissAvSavedPage()) return findMissAvSavedCandidate(direction);
    if (!isMissAvPaginationPage()) return null;

    const current = parseInt(getMissAvCurrentPage() || "1", 10);
    const target = current + (direction === "next" ? 1 : -1);
    if (target < 1) return null;

    const total = getMissAvTotalPages();
    if (direction === "next" && Number.isFinite(total) && total > 0 && current >= total) return null;

    // 优先点击页面中真实的相邻页按钮。
    for (const el of $$('a[href], button, [role="button"], [onclick]')) {
      if (!visible(el) || disabled(el)) continue;
      const n = parseInt(elementPageNumber(el) || "", 10);
      if (n === target) return el;
    }

    // /saved 等页面的“下一页”按钮有时没有可解析页码，但页面会显示“1 / 3”。
    // 只要总页数证明存在相邻页，直接构造 URL，避免被 DOM 结构变化影响。
    if (direction === "next") {
      if ((Number.isFinite(total) && target <= total) || hasMissAvDirectionControl(direction)) {
        const url = makeMissAvPageUrl(target);
        return url ? { __paginationUrl: url } : null;
      }
      return null;
    }

    const url = makeMissAvPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function numericText(el) {
    const dataPage = String(el?.getAttribute?.("data-page") || el?.getAttribute?.("data-page-number") || "").trim();
    if (/^0*\d{1,5}$/.test(dataPage)) return String(parseInt(dataPage, 10));
    const text = (el && (el.value || el.textContent || el.innerText || "")).trim();
    const rule34DataPage = isRule34Video() ? rule34PageFromDataParameters(el) : "";
    if (rule34DataPage) return rule34DataPage;
    const match = text.match(/^0*(\d{1,5})$/);
    return match ? String(parseInt(match[1], 10)) : "";
  }

  function getRule34CurrentPage() {
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;

    const ajaxPage = getRule34VisiblePaginationPage();
    if (ajaxPage) return ajaxPage;

    // AJAX 翻页后地址栏可能不变，优先读取底部分页当前按钮（红色数字）。
    const activeSelectors = [
      ".pagination .active",
      ".pagination .current",
      ".page-link.active",
      ".page-item.active",
      "[class*=pagination] [class*=active]",
      "[class*=pagination] [class*=current]",
      "[aria-current=page]",
    ];
    for (const el of $$(activeSelectors.join(","))) {
      const n = numericText(el);
      if (n) return n;
    }

    // rule34video 的列表页常见格式：/latest-updates/9/；/tags/37807/ 这类末尾数字是 ID，不是页码。
    const pathPage = getRule34PathPage();
    if (pathPage) return pathPage;

    // rule34video 顶部标题通常是：Newest (...) Page 8
    const headingText = $$('h1, h2, .headline, .page-title, [class*="title"], [class*="heading"]')
      .map((el) => el.textContent || "")
      .join("\n");
    const headingMatch = headingText.match(/\bPage\s*0*(\d+)\b/i);
    if (headingMatch) return String(parseInt(headingMatch[1], 10));

    // 底部分页当前按钮通常是红色数字，例如 08；前面已优先读取，这里不再重复。

    const bodyText = document.body ? document.body.innerText.slice(0, 5000) : "";
    const bodyMatch = bodyText.match(/\bPage\s*0*(\d+)\b/i);
    if (bodyMatch) return String(parseInt(bodyMatch[1], 10));
    return "";
  }

  function makePageUrl(targetPage) {
    if (!targetPage || targetPage < 1) return "";
    const url = new URL(location.href);
    const existingKey = ["page", "p", "paged", "pg", "pn", "pageNo", "pageNumber"].find((key) => url.searchParams.has(key));
    if (existingKey) {
      url.searchParams.set(existingKey, String(targetPage));
      if (isXVideos()) url.hash = "_tabVideos";
      return url.href;
    }
    // NodeSeek 帖子分页：/post-174345-3 -> /post-174345-4。
    if (isNodeSeek() && /^\/post-\d+-\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/^(\/post-\d+-)\d+(\/?$)/i, `$1${targetPage}$2`);
      return url.href;
    }

    // 支持 /latest-updates/9/、/category/name/2/ 这类末尾数字页码。
    if (/\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/\d+\/?$/i, `/${targetPage}/`);
      return url.href;
    }
    if (/\/(?:page|p|pg|list)[/-]?\d+(?:\/|$|\.html?$)/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/((?:page|p|pg|list)[/-]?)(\d+)(?=\/|$|\.html?$)/i, `$1${targetPage}`);
      return url.href;
    }
    // rule34video 的列表页常见格式是 /latest-updates/9/，当前 URL 没页码时第一页可构造为 /latest-updates/2/。
    if (isRule34Video()) {
      const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      url.pathname = `${basePath}${targetPage}/`.replace(/\/+/g, "/");
      return url.href;
    }
    return "";
  }

  function elementPageNumber(el) {
    if (!el) return "";
    const href = el.href || el.getAttribute?.("href") || "";
    const fromData = isRule34Video() ? rule34PageFromDataParameters(el) : "";
    if (fromData) return fromData;
    const fromHref = href ? pageFromUrl(href) : "";
    if (fromHref) return fromHref;

    // 很多站点分类页第一页没有页码，下一页链接是 /category/name/2/ 或 /page/2/。
    // 只在分页区域内解析 URL 末尾数字，避免把视频 ID 误判成页码。
    const inPager = isRule34Video()
      ? isRule34PaginationContainer(el)
      : el.closest?.('nav, .pagination, .pager, [class*="pagination"], [class*="pager"], [class*="pages"], [class*="page-numbers"]');
    if (href && inPager) {
      try {
        const url = new URL(href, location.href);
        if (url.origin === location.origin) {
          const match = url.pathname.match(/(?:\/page)?\/0*(\d{1,5})\/?$/i);
          if (match) return String(parseInt(match[1], 10));
        }
      } catch (_) {}
    }

    return numericText(el);
  }

  function findRule34Candidate(direction) {
    const current = parseInt(getRule34CurrentPage() || pageFromUrl() || "", 10);
    const target = Number.isFinite(current) ? current + (direction === "next" ? 1 : -1) : NaN;

    if (target >= 1) {
      const ajaxLink = findRule34AjaxPageLink(target);
      if (ajaxLink) return ajaxLink;

      for (const el of $$('a[href], button, [role="button"], [onclick]')) {
        if (!visible(el) || disabled(el)) continue;
        const n = parseInt(elementPageNumber(el) || "", 10);
        if (n === target) return el;
      }

      // rule34video 上一页/下一页按钮有时会被识别成站点内部错误链接。
      // 先找真实分页 DOM；找不到时才对 /latest-updates/9/ 这类页面构造 URL。
      if (getRule34PathPage()) {
        const url = makePageUrl(target);
        if (url) return { __paginationUrl: url };
      }
    }

    // 识别底部分页两侧的纯箭头按钮。
    const arrowRe = direction === "next" ? /^[\s›»→＞>]+$/ : /^[\s‹«←＜<]+$/;
    const wordRe = direction === "next" ? /\bnext\b|下一页|下页/i : /\bprev\b|\bprevious\b|上一页|上页/i;
    let best = null;
    let bestScore = 0;
    for (const el of $$('a[href], button, [role="button"], [onclick]')) {
      if (!visible(el) || disabled(el)) continue;
      const text = normalizeText(el);
      let score = 0;
      if (arrowRe.test(text)) score += 80;
      if (wordRe.test(text)) score += 80;
      if (rule34PageFromDataParameters(el)) {
        const page = parseInt(rule34PageFromDataParameters(el) || "", 10);
        const targetPage = Number.isFinite(target) ? target : NaN;
        if (Number.isFinite(targetPage) && page !== targetPage) score -= 100;
        else score += 80;
      }
      if (isRule34PaginationContainer(el)) score += 40;
      else if (el.closest('nav, .pagination, .pager, [class*="pagination"], [class*="pager"], [class*="pages"]')) score += 40;
      const rect = el.getBoundingClientRect();
      if (rect.top > innerHeight * 0.45) score += 10;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (bestScore >= 70) return best;

    // 如果页面没有真实链接但 URL 可构造，返回一个虚拟跳转对象。
    const url = target >= 1 ? makePageUrl(target) : "";
    return url ? { __paginationUrl: url } : null;
  }

  function getCurrentPage(numericPager = null) {
    if (isXVideosNewListPage()) {
      const page = getXVideosNewDisplayPage();
      if (page) return page;
    }
    if (isXVideosSearchPage()) {
      const page = getXVideosSearchDisplayPage();
      if (page) return page;
    }

    if (isMissAv()) {
      const sitePage = getMissAvCurrentPage();
      if (sitePage) return sitePage;
    }

    if (isJable()) {
      const sitePage = getJableCurrentPage();
      if (sitePage) return sitePage;
    }

    if (isRule34Video()) {
      const sitePage = getRule34CurrentPage();
      if (sitePage) return sitePage;
    }

    if (isEporner()) {
      const sitePage = getEpornerCurrentPage();
      if (sitePage) return sitePage;
    }

    if (isDiscuz()) {
      const sitePage = getDiscuzCurrentPage();
      if (sitePage) return sitePage;
    }

    if (isNodeSeek()) {
      const sitePage = getNodeSeekCurrentPage();
      if (sitePage) return sitePage;
    }

    if (isWhosTv()) {
      const sitePage = getWhosTvCurrentPage();
      if (sitePage) return sitePage;
    }

    // 通用数字分页放在所有站点专用当前页逻辑之后，避免页面内其他数字组件覆盖站点语义。
    if (numericPager?.currentPage) return numericPager.currentPage;

    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;

    const selectors = [
      ".pagination .active",
      ".pagination .current",
      ".pager .active",
      ".pager .current",
      "nav .active",
      "nav .current",
      ".page-numbers.current",
      ".page-numbers.active",
      "[aria-current=page]",
      "[class*=pagination] [class*=active]",
      "[class*=pagination] [class*=current]",
      "[class*=pager] [class*=active]",
      "[class*=pager] [class*=current]",
      "input[type=number]",
      "input[aria-label*=页]",
      "input[aria-label*=\"page\" i]",
    ];

    for (const el of $$(selectors.join(","))) {
      const value = (el.value || el.textContent || el.innerText || "").trim();
      const match = value.match(/\d+/);
      if (match) return match[0];
    }

    const bodyText = document.body ? document.body.innerText.slice(0, 3000) : "";
    const match = bodyText.match(/(?:第|page\s*)\s*(\d+)\s*(?:页|\/|of)?/i);
    if (match) return match[1];
    return "?";
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
    // 点击时重新确认数字分页快照并传给统一候选识别，避免无 class 数字分页丢失，
    // 也避免通用评分把分页区中的任意数字链接错当成相邻页。
    // 快照仍然有效时直接复用，不重复扫描全页。
    const numericPager = detectNumericPagerCached();
    const cached = STATE.candidateEpoch === STATE.domEpoch ? STATE[direction] : null;
    const candidate = (cached instanceof Element && cached.isConnected)
      ? cached
      : safeCall(`${direction} 点击前识别失败`, () => findCandidate(direction, numericPager), null);
    STATE.numericPager = numericPager;
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
    if (!(el instanceof Element) || isOwnUiElement(el) || blocked(el)) return;
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

  function isNodeSeek() {
    return hostIs(HOST_NODESEEK);
  }

  function getNodeSeekCurrentPage() {
    if (!isNodeSeek()) return "";
    const fromUrl = pageFromUrl();
    if (fromUrl) return fromUrl;
    for (const el of $$('a[href^="/page-"], a[href*="/page-"]')) {
      const text = (el.textContent || el.innerText || "").trim();
      if (/^1$/.test(text) && visible(el)) return "1";
    }
    return "1";
  }

  function makeNodeSeekPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isNodeSeek() || !Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    if (/^\/page-\d+\/?$/i.test(url.pathname)) {
      url.pathname = `/page-${targetPage}`;
      url.search = "";
      url.hash = "";
      return url.href;
    }
    if (/^\/categories\/[^/]+(?:\/page-\d+)?\/?$/i.test(url.pathname)) {
      const base = url.pathname.replace(/\/page-\d+\/?$/i, "").replace(/\/+$/g, "");
      url.pathname = targetPage <= 1 ? base : `${base}/page-${targetPage}`;
      url.hash = "";
      return url.href;
    }
    return "";
  }

  function findNodeSeekPageLink(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isNodeSeek() || !Number.isFinite(targetPage) || targetPage < 1) return null;
    for (const el of $$('a[href]')) {
      if (!visible(el) || disabled(el)) continue;
      const page = parseInt(elementPageNumber(el) || "", 10);
      if (page === targetPage) return el;
    }
    return null;
  }

  function findNodeSeekCandidate(direction) {
    if (!isNodeSeek()) return null;
    const current = parseInt(getNodeSeekCurrentPage() || "1", 10);
    const target = current + (direction === "next" ? 1 : -1);
    if (!Number.isFinite(target) || target < 1) return null;

    const link = findNodeSeekPageLink(target);
    if (link?.href) {
      // NodeSeek 会拦截分页链接并进行站内局部换页。在 userscript 的 content world 中，
      // 这类 SPA 路由可能不会触发上面的 history hook，旧状态会停在 navigating，
      // 页面内容虽已翻页，但翻页工具不会重新完成识别。改为使用真实链接做完整导航，
      // 让 Safari 在新文档中重新注入全部浏览器脚本。
      try {
        return { __paginationUrl: new URL(link.href, location.href).href };
      } catch (_) {}
    }

    const url = makeNodeSeekPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }

  function isWhosTv() {
    return hostIs(HOST_WHOSTV);
  }

  function isWhosTvFramesListPage() {
    if (!isWhosTv()) return false;
    return /^\/frames\/(?:type-[^/]+|tags|tag-[^/]+|label-\d+)(?:\/[^/]+)*(?:\/page-\d+)?\/?$/i.test(location.pathname);
  }

  function getWhosTvCurrentPage() {
    if (!isWhosTvFramesListPage()) return "";
    const match = location.pathname.match(/\/page-0*(\d{1,5})\/?$/i);
    return match ? String(parseInt(match[1], 10)) : "1";
  }

  function makeWhosTvPageUrl(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isWhosTvFramesListPage() || !Number.isFinite(targetPage) || targetPage < 1) return "";
    const url = new URL(location.href);
    const base = url.pathname.replace(/\/page-\d+\/?$/i, "").replace(/\/+$/g, "");
    url.pathname = targetPage <= 1 ? base : `${base}/page-${targetPage}`;
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function findWhosTvPageLink(targetPage) {
    targetPage = parseInt(targetPage, 10);
    if (!isWhosTvFramesListPage() || !Number.isFinite(targetPage) || targetPage < 1) return null;
    for (const el of $$('a[href]')) {
      if (!visible(el) || disabled(el)) continue;
      const href = el.getAttribute("href") || "";
      if (!/\/frames\//i.test(href) || !/\/page-\d+/i.test(href)) continue;
      const page = parseInt(pageFromUrl(el.href) || elementPageNumber(el) || "", 10);
      if (page === targetPage) return el;
    }
    return null;
  }

  function findWhosTvCandidate(direction) {
    if (!isWhosTvFramesListPage()) return null;
    const current = parseInt(getWhosTvCurrentPage() || "1", 10);
    const target = current + (direction === "next" ? 1 : -1);
    if (!Number.isFinite(target) || target < 1) return null;

    const link = findWhosTvPageLink(target);
    if (link) return link;

    const url = makeWhosTvPageUrl(target);
    return url ? { __paginationUrl: url } : null;
  }


  function controlsAreAdjacent(leftControl, rightControl) {
    if (!leftControl?.isConnected || !rightControl?.isConnected) return false;
    const leftRect = leftControl.getBoundingClientRect();
    const rightRect = rightControl.getBoundingClientRect();
    return leftRect.width > 0 && leftRect.height > 0 && rightRect.width > 0 && rightRect.height > 0 &&
      Math.abs(leftRect.right - rightRect.left) <= 1.5 && Math.abs(leftRect.top - rightRect.top) <= 1.5;
  }

  function setConnectedVisual(box, anchor) {
    const base = document.getElementById(BASE_TOOLBAR_ID);
    const fullscreen = document.getElementById(VIDEO_FULLSCREEN_ID);
    const connectedLeft = Boolean(anchor?.isConnected) && controlsAreAdjacent(anchor, box);
    const connectedRight = controlsAreAdjacent(box, fullscreen);
    box.dataset.connectedLeft = connectedLeft ? "true" : "false";
    box.dataset.connectedRight = connectedRight ? "true" : "false";

    if (base) base.dataset.connectedRight = connectedLeft ? "true" : "false";
    if (fullscreen) {
      fullscreen.dataset.connectedLeft = connectedRight ? "true" : "false";
      fullscreen.dataset.connectedRight = "false";
    }
  }

  function refreshConnectedVisual(box) {
    const base = document.getElementById(BASE_TOOLBAR_ID);
    setConnectedVisual(box, controlsAreAdjacent(base, box) ? base : null);
  }

  function observeBaseToolbar(base) {
    if (STATE.observedToolbar === base) return;
    STATE.toolbarObserver?.disconnect();
    STATE.toolbarResizeObserver?.disconnect();
    STATE.observedToolbar = base || null;
    if (!base) return;
    STATE.toolbarObserver = new MutationObserver(schedulePosition);
    STATE.toolbarObserver.observe(base, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    if (typeof ResizeObserver === "function") {
      STATE.toolbarResizeObserver = new ResizeObserver(schedulePosition);
      STATE.toolbarResizeObserver.observe(base);
    }
  }

  function applyPosition(box) {
    if (!box?.isConnected) return;
    const base = document.getElementById(BASE_TOOLBAR_ID);
    const anchor = base;
    observeBaseToolbar(anchor);
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        box.style.left = `${rect.right - CONNECT_OVERLAP}px`;
        box.style.right = "auto";
        const usesBottom = anchor.style.bottom && anchor.style.bottom !== "auto" && (!anchor.style.top || anchor.style.top === "auto");
        if (usesBottom) {
          box.style.bottom = anchor.style.bottom;
          box.style.top = "auto";
        } else {
          box.style.top = `${rect.top}px`;
          box.style.bottom = "auto";
        }
        // 位置由同一锚点直接计算，连接状态也按该锚点同步设置，
        // 避免两个独立脚本在同一帧交错测量时出现“一边方、一边圆”的短暂错位。
        setConnectedVisual(box, anchor);
        return;
      }
    }
    box.style.right = `${DEFAULT_RIGHT_GAP}px`;
    box.style.bottom = `${DEFAULT_BOTTOM_GAP}px`;
    box.style.left = "auto";
    box.style.top = "auto";
    refreshConnectedVisual(box);
  }

  function schedulePosition() {
    requestRefresh(REFRESH_LAYOUT);
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
      #${SCRIPT_ID}[data-connected-left="true"] { border-radius: 0 999px 999px 0; box-shadow: inset -.5px 0 0 var(--qpn-separator), inset 0 .5px 0 var(--qpn-separator), inset 0 -.5px 0 var(--qpn-separator); }
      #${SCRIPT_ID}[data-connected-right="true"] { border-radius: 999px 0 0 999px; box-shadow: inset .5px 0 0 var(--qpn-separator), inset 0 .5px 0 var(--qpn-separator), inset 0 -.5px 0 var(--qpn-separator); }
      #${SCRIPT_ID}[data-connected-left="true"][data-connected-right="true"] { border-radius: 0; box-shadow: inset 0 .5px 0 var(--qpn-separator), inset 0 -.5px 0 var(--qpn-separator); }
      #${SCRIPT_ID}[data-connected-left="true"]::before { content: ""; position: absolute; z-index: 2; left: 0; top: 7px; bottom: 7px; width: 1px; background: var(--qpn-separator); pointer-events: none; }
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
    box.dataset.connectedLeft = "false";
    box.dataset.connectedRight = "false";
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
    document.documentElement.appendChild(box);
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
    schedulePosition();
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
      STATE.numericPager = numericPager;
      observePagerRoot(numericPager?.root || null);
      const candidates = findBothCandidates(numericPager);
      STATE.prev = candidates.prev;
      STATE.next = candidates.next;
      STATE.candidateEpoch = STATE.domEpoch;
      const box = ensureToolbar();
      if (!box) return;
      box.querySelector(".prev").disabled = !STATE.prev;
      box.querySelector(".next").disabled = !STATE.next;
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
      schedulePosition();
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
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.some((node) => {
      if (!(node instanceof Element)) return false;
      if (node.id === BASE_TOOLBAR_ID || node.id === VIDEO_FULLSCREEN_ID || node.id === SCRIPT_ID || node.id === STYLE_ID || node.tagName === "HTML" || node.tagName === "BODY" || node.tagName === "HEAD") return true;
      if (node.querySelector?.(`#${BASE_TOOLBAR_ID}, #${VIDEO_FULLSCREEN_ID}`) || elementHasPaginationSignal(node)) return true;
      return [...(node.querySelectorAll?.('a, button, [role="button"], [rel~="next"], [rel~="prev"], [data-page], [data-page-number], [aria-current="page"]') || [])]
        .slice(0, 80).some(elementHasPaginationSignal);
    });
  }

  const REFRESH_STRUCTURE = 1;
  const REFRESH_CONTENT = 2;
  const REFRESH_LAYOUT = 4;
  const REFRESH_FULL = REFRESH_STRUCTURE | REFRESH_CONTENT | REFRESH_LAYOUT;
  const REFRESH_RETRY_DELAYS = [120, 300, 700, 1500, 3000, 6000];

  function scheduleRefreshRetry() {
    if (document.hidden || STATE.retryTimer || STATE.refreshRetryCount >= REFRESH_RETRY_DELAYS.length) return;
    const delay = REFRESH_RETRY_DELAYS[STATE.refreshRetryCount++];
    STATE.retryTimer = setTimeout(() => {
      STATE.retryTimer = null;
      requestRefresh(REFRESH_FULL, 0);
    }, delay);
  }

  function requestRefresh(flags = REFRESH_FULL, contentDelay = 0) {
    STATE.pendingRefreshFlags |= flags;
    if (flags & REFRESH_CONTENT) STATE.contentDelay = Math.min(STATE.contentDelay, Math.max(0, contentDelay));
    if ((document.hidden && INSTANCE.phase !== "starting") || STATE.refreshScheduled) return;
    STATE.refreshScheduled = true;
    const run = () => {
      STATE.refreshScheduled = false;
      const currentFlags = STATE.pendingRefreshFlags;
      const currentContentDelay = Number.isFinite(STATE.contentDelay) ? STATE.contentDelay : 0;
      STATE.pendingRefreshFlags = 0;
      STATE.contentDelay = Infinity;
      const root = document.documentElement || document.body;
      if (!root) {
        STATE.pendingRefreshFlags |= REFRESH_FULL;
        STATE.contentDelay = Math.min(STATE.contentDelay, 0);
        scheduleRefreshRetry();
        return;
      }
      try {
        if (currentFlags & REFRESH_STRUCTURE) {
          STATE.navigating = false;
          installLifecycleListenersOnce();
          installSharedHistoryHook();
          ensureToolbar();
          ensureDocumentObserver();
          normalizeXVideosHashLater();
        }
        if (currentFlags & REFRESH_CONTENT) scheduleUpdate(currentContentDelay);
        if (currentFlags & REFRESH_LAYOUT) {
          const box = document.getElementById(SCRIPT_ID);
          if (box) applyPosition(box);
        }
        STATE.initialized = true;
        INSTANCE.phase = "running";
        STATE.refreshRetryCount = 0;
        if (STATE.retryTimer) {
          clearTimeout(STATE.retryTimer);
          STATE.retryTimer = null;
        }
      } catch (error) {
        STATE.initialized = false;
        INSTANCE.phase = "failed";
        STATE.pendingRefreshFlags |= REFRESH_FULL;
        STATE.contentDelay = Math.min(STATE.contentDelay, 0);
        log("刷新恢复中", error);
        scheduleRefreshRetry();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
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

  function installNodeSeekNavigationGuard() {
    if (!isNodeSeek()) return;
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      let url;
      try { url = new URL(link.href, location.href); } catch (_) { return; }
      if (url.origin !== location.origin) return;
      if (!/^\/page-\d+\/?$/i.test(url.pathname) && !/^\/categories\/[^/]+\/page-\d+\/?$/i.test(url.pathname)) return;
      // 在站点的 SPA 点击处理器之前接管分页，确保新文档重新注入所有 userscript。
      event.preventDefault();
      event.stopImmediatePropagation();
      hardNavigate(url.href);
    }, true);
  }

  function recoverRefresh() {
    STATE.refreshRetryCount = 0;
    invalidatePagerCache();
    requestRefresh(REFRESH_FULL, 0);
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
    installNodeSeekNavigationGuard();
    window.addEventListener("floating-accessories-change", () => requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT));
    window.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.addEventListener("scroll", () => requestRefresh(REFRESH_LAYOUT), { passive: true });
    window.visualViewport?.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.visualViewport?.addEventListener("scroll", () => requestRefresh(REFRESH_LAYOUT));
    window.addEventListener("pageshow", recoverRefresh);
    window.addEventListener("focus", recoverRefresh);
    document.addEventListener("readystatechange", recoverRefresh);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) recoverRefresh();
    });
  }

  function ensureDocumentObserver() {
    if (STATE.observer) return;
    STATE.observer = new MutationObserver((mutations) => {
      const currentBox = document.getElementById(SCRIPT_ID);
      const toolbarBroken = !currentBox || currentBox !== STATE.toolbar || currentBox.querySelector(".prev") !== STATE.prevButton || currentBox.querySelector(".next") !== STATE.nextButton;
      if (toolbarBroken || document.getElementById(STYLE_ID) !== STATE.styleElement || !STATE.styleElement?.isConnected) {
        invalidatePagerCache();
        requestRefresh(REFRESH_FULL, 120);
        return;
      }
      // 无限滚动站点会持续产生大量 mutation，同一节流窗口内只做一次深度判定；
      // 被节流掉的批次不丢弃，改用一次延迟补扫兼顾准确性。
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
      if (mutations.some(mutationTouchesRelevantUi)) {
        invalidatePagerCache();
        requestRefresh(REFRESH_FULL, 120);
      }
    });
    STATE.observer.observe(document, { subtree: true, childList: true });
  }

  function resume() {
    recoverRefresh();
    return true;
  }

  function init() {
    requestRefresh(REFRESH_FULL, 0);
  }

  INSTANCE.resume = resume;
  init();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => requestRefresh(REFRESH_FULL, 0), { once: true });
})();
