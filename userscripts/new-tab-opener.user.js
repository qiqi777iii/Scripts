// ==UserScript==
// @name         新标签页打开
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.8.5
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/new-tab-opener.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/new-tab-opener.user.js
// @description  在网页显示悬浮开关，控制链接是否在 Safari 新标签页中打开并直接跳转。
// @match        *://*/*
// @grant        GM.openInTab
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.addValueChangeListener
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = '__newTabOpenerInstanceV1__';
    const previousInstance = document[INSTANCE_KEY];
    if (previousInstance?.resume) {
        previousInstance.resume('reinjected');
        return;
    }
    const INSTANCE = { phase: 'starting', resume: null };
    document[INSTANCE_KEY] = INSTANCE;

    const KEY = '__tb_';
    const SHARED_ENABLED_KEY_PREFIX = 'newTabEnabledBySite:';
    const BTN_SIZE = /(^|\.)nodeseek\.com$/i.test(location.hostname) ? 32 : 40;
    const BOTTOM_GAP = 40;
    const LINK_TOOLBAR_GAP = 0;
    const CONNECT_OVERLAP = 1;
    const TOOLBAR_RIGHT_GAP = 16;
    const NEIGHBOR_TOOLBAR_HEIGHT = BTN_SIZE;
    const DEFAULT_BOTTOM = BOTTOM_GAP + (NEIGHBOR_TOOLBAR_HEIGHT - BTN_SIZE) / 2;
    const FALLBACK_TOOLBAR_WIDTH = BTN_SIZE * 2;
    const DEFAULT_RIGHT = TOOLBAR_RIGHT_GAP + FALLBACK_TOOLBAR_WIDTH + LINK_TOOLBAR_GAP;
    const GROUP_DRAG_EVENT = 'floating-toolbar-group-drag';
    const SHARED_URL_CHANGE_EVENT = 'scripts:urlchange';
    const SHARED_HISTORY_HOOK_KEY = '__sharedHistoryHookV1__';
    const COVER_PREVIEW_READY_ATTR = 'data-cover-preview-ready';
    const BACKGROUND_OPEN_REQUEST_EVENT = 'scripts:background-open-request';
    const TAB_CHECK_REQUEST_EVENT = 'scripts:tab-check-request';
    const SENSITIVE_ACTION_NAMES = new Set([
        'login', 'signin', 'signout', 'logout', 'auth', 'authorize', 'oauth', 'sso', 'saml',
        'account', 'checkout', 'payment', 'pay', 'billing', 'subscribe', 'purchase', 'confirm',
        'action', 'delete', 'remove', 'follow', 'like', 'vote', 'favorite', 'bookmark', 'cart'
    ]);
    const DUPLICATE_OPEN_WINDOW = 400;

    // 封面预览联动表：只用于把这些站的封面点击让给 cover-video-preview 脚本处理，
    // 不再限制链接是否为视频详情页；其余链接判定走通用规则。
    const COVER_TARGET_RULES = {
        'rule34video.com': function (target) { return Boolean(target.closest('[data-preview]')); },
        'spankbang.com': function (target) {
            const link = target.closest('a[href]');
            return Boolean(link && link.closest('.video-item, .js-video-item, [id^="recommended_video"]') && link.querySelector('img, video, source'));
        },
        'eporner.com': function (target) { return Boolean(target.closest('.mbimg')); },
        'xhamster.com': function (target) { return Boolean(target.closest('a[data-previewvideo][href*="/videos/"]')); },
    };

    // 不跳转链接表：命中时点击既不新标签页打开也不放行原生跳转，只按下不动。
    // 目前用于站点顶部标题/Logo 这类点了没有实际意义的入口。
    const NO_NAV_TARGET_RULES = {
        'eporner.com': function (a) { return Boolean(a.closest('#logo')); },
    };

    let enabled = getVal('newTabEnabled', false);
    let enabledRevision = 0;
    const sharedSiteKey = getSharedSiteKey(location.hostname);
    const sharedEnabledKey = SHARED_ENABLED_KEY_PREFIX + sharedSiteKey;
    const coverTargetRule = COVER_TARGET_RULES[sharedSiteKey] || null;
    const noNavTargetRule = NO_NAV_TARGET_RULES[sharedSiteKey] || null;
    const isMissAvSite = /(^|\.)missav\./i.test(location.hostname);
    let lastOpenedHref = '';
    let lastOpenedAt = 0;
    // 链接判定缓存：翻页与敏感判定都需要遍历 DOM 或分词，
    // 列表页同一链接反复点击时直接复用结果。WeakMap 不阻止元素回收。
    const linkVerdictCache = new WeakMap();
    // 当前页面 URL 分量缓存，避免每次点击重建 new URL(location.href)。
    let currentUrlParts = null;

    function getLinkVerdict(a) {
        let verdict = linkVerdictCache.get(a);
        if (!verdict) {
            verdict = {};
            linkVerdictCache.set(a, verdict);
        }
        return verdict;
    }

    function refreshCurrentUrlParts() {
        const current = new URL(location.href);
        currentUrlParts = { href: location.href, origin: current.origin, pathname: current.pathname, search: current.search };
        return currentUrlParts;
    }
    // 上一次已写入的默认位置；值未变时跳过样式写入，减少滚动时的重排。
    let lastAppliedLayout = null;
    let toolbar, linkBtn, styleElement, bodyObserver, neighborResizeObserver, neighborMutationObserver, observedNeighbor;
    let listenersInstalled = false;
    let lastHref = location.href;
    let initRetryTimer = null;
    let refreshRetryCount = 0;
    let pendingRefreshFlags = 0;
    let refreshFrame = null;
    // 页面内临时位置；刷新页面后变量会重建并恢复默认位置。
    let savedPosition = null;
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let dragNeighborToolbar = null, startNeighborLeft = 0, startNeighborTop = 0;
    let valueChangeListenerInstalled = false;

    function getVal(key, def) {
        try {
            const v = localStorage.getItem(KEY + key);
            if (v === null) return def;
            if (v === 'true') return true;
            if (v === 'false') return false;
            const n = Number(v);
            return Number.isNaN(n) ? v : n;
        } catch (_) { return def; }
    }

    function setVal(key, val) {
        try { localStorage.setItem(KEY + key, String(val)); } catch (_) {}
    }

    function getSharedSiteKey(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/^\.+|\.+$/g, '');
        if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;

        const parts = host.split('.').filter(Boolean);
        if (parts.length <= 2) return host;

        const compoundSuffixes = new Set([
            'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
            'co.uk', 'org.uk', 'me.uk', 'ac.uk',
            'com.au', 'net.au', 'org.au', 'edu.au',
            'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
            'co.kr', 'or.kr', 'ne.kr',
            'co.nz', 'org.nz', 'net.nz',
            'com.sg', 'com.hk', 'com.tw', 'com.br', 'com.mx', 'co.in'
        ]);
        const suffix = parts.slice(-2).join('.');
        return parts.slice(compoundSuffixes.has(suffix) ? -3 : -2).join('.');
    }

    async function loadEnabledState() {
        const revision = enabledRevision;
        const localValue = getVal('newTabEnabled', false);
        let nextValue = localValue;
        if (typeof GM !== 'undefined' && GM.getValue) {
            try {
                const sharedValue = await GM.getValue(sharedEnabledKey, null);
                nextValue = sharedValue === null ? localValue : Boolean(sharedValue);
                if (sharedValue === null && GM.setValue) await GM.setValue(sharedEnabledKey, nextValue);
            } catch (_) {
                nextValue = localValue;
            }
        }
        if (revision !== enabledRevision) return;
        enabled = nextValue;
        setVal('newTabEnabled', enabled);
    }

    function saveEnabledState() {
        setVal('newTabEnabled', enabled);
        if (typeof GM === 'undefined' || !GM.setValue) return;
        try {
            const result = GM.setValue(sharedEnabledKey, enabled);
            if (result && typeof result.catch === 'function') result.catch(function () {});
        } catch (_) {}
    }

    function isolateFloatingUi(root) {
        function absorb(e) {
            e.preventDefault();
            e.stopPropagation();
        }
        ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click'].forEach(function (type) {
            root.addEventListener(type, absorb, { passive: false });
        });
    }

    function isPaginationContainer(link) {
        let node = link;
        for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
            const className = typeof node.className === 'string' ? node.className : '';
            const marker = [
                node.id || '',
                className,
                node.getAttribute?.('aria-label') || '',
                node.getAttribute?.('data-testid') || '',
            ].join(' ');
            if (/(^|[\s_-])(pagination|paginator|pager|paging|pagenavi|page-nav|page-navigation|nav-pages|page-numbers)([\s_-]|$)/i.test(marker)) return true;
            if (node.tagName === 'NAV' && /(page|pagination|pager|分页|分頁|翻页|翻頁)/i.test(marker)) return true;
        }
        return false;
    }

    function isPaginationLink(link) {
        if (!link) return false;

        let url;
        try { url = new URL(link.href, location.href); } catch (_) { return false; }
        if (!/^https?:$/i.test(url.protocol) || url.origin !== location.origin) return false;

        const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
        if (rel.includes('next') || rel.includes('prev')) return true;

        const className = typeof link.className === 'string' ? link.className : '';
        const structuralMarker = [
            link.id || '',
            className,
            link.getAttribute('data-testid') || '',
        ].join(' ');
        const marker = [
            structuralMarker,
            link.getAttribute('aria-label') || '',
            link.getAttribute('title') || '',
        ].join(' ');
        const labelCandidates = [
            link.textContent || '',
            link.getAttribute('aria-label') || '',
            link.getAttribute('title') || '',
        ].map(function (label) {
            return label.replace(/\s+/g, ' ').replace(/[<>{}\[\]()‹›«»←→]/g, '').trim();
        }).filter(Boolean);

        const isNamedPager = /(^|[\s_-])(pnnext|pnprev|next|prev|previous|next-page|prev-page|previous-page|page-next|page-prev)([\s_-]|$)/i.test(structuralMarker);
        if (isNamedPager) return true;

        const isDirectionLabel = labelCandidates.some(function (label) {
            return /^(首页|尾页|首頁|末頁|上一页|下一页|前一页|后一页|上一頁|下一頁|前一頁|後一頁|上页|下页|上頁|下頁|更多结果|更多結果|first(?: page)?|last(?: page)?|next(?: page)?|prev(?:ious)?(?: page)?|newer|older|more results?|show more|次へ|前へ|다음|이전)$/i.test(label);
        });
        if (isDirectionLabel) return true;

        const isPageNumber = labelCandidates.some(function (label) { return /^\d+$/.test(label); });
        const isPageLabel = labelCandidates.some(function (label) { return /^(?:go to )?page\s*\d+$|^第\s*\d+\s*[页頁]$/i.test(label); });
        const dataPage = link.getAttribute('data-page') || link.getAttribute('data-page-number') || '';
        const hasPageUrl = /[?&](?:p|pg|page|paged|pageno|page_no|pagenum|page_num|pageindex|page_index|page_number|offset|start)=\d+/i.test(url.search) || /\/(?:page|paged|p)[/-]?\d+(?:[./-]|$)/i.test(url.pathname);
        if (isPageLabel || /^\d+$/.test(dataPage) || (isPageNumber && hasPageUrl)) return true;

        const inPager = isPaginationContainer(link);
        if (!inPager) return false;

        const hasPageMarker = /(^|[\s_-])(page|page-item|page-link|page-number|page-numbers|next|prev|previous)([\s_-]|$)/i.test(marker);
        return isPageNumber || hasPageMarker || hasPageUrl;
    }

    function getMissAvPreviewContext(a) {
        if (!isMissAvSite || !a) return null;
        const card = a.closest?.('.thumbnail');
        const preview = card?.querySelector?.('video.preview');
        if (!card || !preview) return null;
        const previewLink = preview.closest('a[href]');
        return previewLink ? { card, preview, previewLink } : null;
    }

    function isMissAvDetailMetadataLink(a, url) {
        if (!a || !/^\/(?:dm\d+\/)?[^/]+\/(?:genres|series|makers|directors|labels)\//i.test(url.pathname)) return false;
        const row = a.closest?.('div.text-secondary');
        if (!row) return false;
        const label = (row.querySelector(':scope > span')?.textContent || '').replace(/\s+/g, '').replace(/[：:]+$/, '');
        return /^(?:类型|類型|系列|发行商|發行商|导演|導演|标签|標籤|標簽)$/.test(label);
    }

    function shouldBackgroundOpenOnMissAv(a, url) {
        if (!isMissAvSite) return true;

        // 详情页中的类型、系列、发行商、导演和标签链接也进入新标签页；
        // 其余站内导航、筛选、排序、翻页、语言切换与账户操作维持网站原本行为。
        if (isMissAvDetailMetadataLink(a, url)) return true;

        const context = getMissAvPreviewContext(a);
        if (!context) return false;

        let previewUrl;
        try { previewUrl = new URL(context.previewLink.href, document.baseURI); } catch (_) { return false; }
        return url.origin === previewUrl.origin &&
            url.pathname === previewUrl.pathname &&
            url.search === previewUrl.search;
    }

    function installEnabledStateListener() {
        if (valueChangeListenerInstalled || typeof GM === 'undefined' || !GM.addValueChangeListener) return;
        valueChangeListenerInstalled = true;
        GM.addValueChangeListener(sharedEnabledKey, function (_key, _oldValue, newValue) {
            if (typeof newValue !== 'boolean' || newValue === enabled) return;
            enabledRevision += 1;
            enabled = newValue;
            setVal('newTabEnabled', enabled);
            requestRefresh(REFRESH_CONTENT);
        });
    }

    function nextFrame(fn) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
        else setTimeout(fn, 16);
    }

    const REFRESH_STRUCTURE = 1;
    const REFRESH_CONTENT = 2;
    const REFRESH_LAYOUT = 4;
    const REFRESH_FULL = REFRESH_STRUCTURE | REFRESH_CONTENT | REFRESH_LAYOUT;
    const REFRESH_RETRY_DELAYS = [120, 300, 700, 1500, 3000, 6000];

    function scheduleRefreshRetry() {
        if (document.hidden || initRetryTimer || refreshRetryCount >= REFRESH_RETRY_DELAYS.length) return;
        const delay = REFRESH_RETRY_DELAYS[refreshRetryCount++];
        initRetryTimer = setTimeout(function () {
            initRetryTimer = null;
            requestRefresh(REFRESH_FULL);
        }, delay);
    }

    function requestRefresh(flags = REFRESH_FULL) {
        pendingRefreshFlags |= flags;
        if ((document.hidden && INSTANCE.phase !== 'starting') || refreshFrame != null) return;
        const run = function () {
            refreshFrame = null;
            const currentFlags = pendingRefreshFlags;
            pendingRefreshFlags = 0;
            const root = document.documentElement || document.body;
            if (!root) {
                pendingRefreshFlags |= REFRESH_FULL;
                scheduleRefreshRetry();
                return;
            }
            try {
                if (currentFlags & REFRESH_STRUCTURE) {
                    installPositionListenersOnce();
                    hookHistoryForUrlChange();
                    ensureToolbar();
                    startBodyGuard();
                }
                if (currentFlags & REFRESH_CONTENT) updateBtn();
                if (currentFlags & REFRESH_LAYOUT) {
                    if (!toolbar || dragging) return;
                    if (savedPosition) applySavedPosition();
                    else applyDefaultPosition();
                    refreshConnectedVisual();
                    toolbar.style.transform = 'translate3d(0,0,0)';
                }
                INSTANCE.phase = 'running';
                refreshRetryCount = 0;
                if (initRetryTimer) {
                    clearTimeout(initRetryTimer);
                    initRetryTimer = null;
                }
            } catch (_) {
                INSTANCE.phase = 'failed';
                pendingRefreshFlags |= REFRESH_FULL;
                scheduleRefreshRetry();
            }
        };
        nextFrame(run);
        refreshFrame = true;
    }

    function findLinkTarget(target) {
        return target?.closest?.('a[href], area[href]');
    }

    function openLinkWithAnchor(href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.dataset.tbInternalOpen = 'true';
        link.style.position = 'fixed';
        link.style.left = '-9999px';
        link.style.top = '-9999px';
        link.style.width = '1px';
        link.style.height = '1px';
        link.style.opacity = '0';
        (document.body || document.documentElement).appendChild(link);
        try {
            link.click();
        } catch (_) {}
        setTimeout(function () { link.remove(); }, 0);
    }

    function openLinkInBackground(href) {
        if (!href) return;
        try {
            if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
                // 前台打开：新标签页创建后直接跳转到该标签页。
                const task = GM.openInTab(href, { active: true });
                if (task && typeof task.catch === 'function') {
                    task.catch(function () { openLinkWithAnchor(href); });
                }
                return;
            }
        } catch (_) {}
        openLinkWithAnchor(href);
    }

    function requestCheckedBackgroundOpen(href, sourceLink) {
        if (!href) return;
        // 短时去重：避免连点或站点二次触发开出多个相同标签页。
        const now = Date.now();
        if (href === lastOpenedHref && now - lastOpenedAt < DUPLICATE_OPEN_WINDOW) return;
        lastOpenedHref = href;
        lastOpenedAt = now;
        const event = new CustomEvent(TAB_CHECK_REQUEST_EVENT, {
            cancelable: true,
            detail: { href, sourceLink: sourceLink || null }
        });
        window.dispatchEvent(event);
        if (!event.defaultPrevented) openLinkInBackground(href);
    }

    function getMissAvHiddenPreview(a) {
        const context = getMissAvPreviewContext(a);
        return context?.preview.classList.contains('hidden') ? context : null;
    }

    function hasNativePreviewHandler(a, context) {
        return [a, context.previewLink, context.preview, context.card].filter(Boolean).some(function (node) {
            return node.getAttributeNames?.().some(function (name) {
                return /^(?:onclick|onpointerup|ontouchend|@click(?:\.|$)|x-on:click(?:\.|$)|data-action|data-preview-action)$/i.test(name);
            });
        });
    }

    function activateMissAvPreview(context) {
        const { preview, previewLink } = context;
        const src = preview.getAttribute('src') || preview.getAttribute('data-src');
        if (src && !preview.getAttribute('src')) preview.setAttribute('src', src);
        preview.classList.remove('hidden');
        previewLink.querySelector('img')?.classList.add('hidden');
        const task = preview.play?.();
        if (task?.catch) task.catch(function () {});
    }

    function hasInlineAction(a) {
        return a.getAttributeNames?.().some(function (name) {
            return /^(?:onclick|onmousedown|onmouseup|onpointerdown|onpointerup|ontouchstart|ontouchend|@click(?:\.|$)|x-on:click(?:\.|$)|data-action|data-confirm|data-method|data-turbo-method|data-remote|formaction|hx-(?:post|put|patch|delete))$/i.test(name);
        });
    }

    function isExplicitInteractiveLink(a) {
        if (a.hasAttribute('target') || a.hasAttribute('download') || a.hasAttribute('ping') || hasInlineAction(a)) return true;
        const marker = [a.id, a.className, a.getAttribute('rel'), a.getAttribute('role'), a.getAttribute('data-lightbox'), a.getAttribute('data-fancybox'), a.getAttribute('data-gallery')].filter(Boolean).join(' ');
        if (/(?:^|[\s_-])(?:preview|lightbox|fancybox|modal|gallery|photoswipe|viewer|zoom)(?:[\s_-]|$)/i.test(marker)) return true;
        return Boolean(a.closest('form, dialog, [role="dialog"], [role="button"], [aria-haspopup], [data-confirm], [data-method], [data-turbo-method], [data-action], [contenteditable="true"]'));
    }

    function normalizeActionName(value) {
        let decoded = String(value || '');
        try { decoded = decodeURIComponent(decoded); } catch (_) {}
        return decoded.toLowerCase()
            .replace(/\.(?:html?|php|aspx?)$/i, '')
            .replace(/[-_]/g, '');
    }

    function isSensitiveActionLink(a, url) {
        const pathHasAction = url.pathname.split('/').filter(Boolean).some(function (segment) {
            return SENSITIVE_ACTION_NAMES.has(normalizeActionName(segment));
        });
        if (pathHasAction) return true;

        const elementTokens = [a.id || '', typeof a.className === 'string' ? a.className : '']
            .join(' ')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        if (elementTokens.some(function (token) { return SENSITIVE_ACTION_NAMES.has(token); })) return true;

        for (const key of url.searchParams.keys()) {
            if (/^(?:action|method|cmd|command|do|operation)$/i.test(key)) return true;
        }
        return false;
    }

    function getBackgroundOpenUrl(a) {
        // 排序按「代价低、淘汰率高」优先：开关 → href 快速判空 → URL 解析 →
        // 站点规则 → 交互链接 → 敏感链接 → 翻页链接（最贵，需向上遍历 DOM）。
        if (!enabled || !a || a.dataset.tbInternalOpen === 'true') return null;
        const rawHref = (a.getAttribute('href') || '').trim();
        if (!rawHref || rawHref[0] === '#') return null;
        let url;
        try { url = new URL(rawHref, document.baseURI); } catch (_) { return null; }
        if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return null;

        if (!shouldBackgroundOpenOnMissAv(a, url)) return null;

        if (isExplicitInteractiveLink(a)) return null;

        // 同一元素且 href 未变时复用敏感/翻页判定结果。
        const verdict = getLinkVerdict(a);
        if (verdict.href !== url.href) {
            verdict.href = url.href;
            verdict.sensitive = undefined;
            verdict.pagination = undefined;
        }
        if (verdict.sensitive === undefined) verdict.sensitive = isSensitiveActionLink(a, url);
        if (verdict.sensitive) return null;

        const current = currentUrlParts?.href === location.href ? currentUrlParts : refreshCurrentUrlParts();
        if (url.origin === current.origin && url.pathname === current.pathname && url.search === current.search && url.hash) return null;

        if (verdict.pagination === undefined) verdict.pagination = isPaginationLink(a);
        if (verdict.pagination) return null;
        return url.href;
    }

    function isPlainPrimaryClick(e) {
        return enabled && !e.defaultPrevented && e.isTrusted !== false && e.button === 0 &&
            !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    }

    function isCoverPreviewTarget(target) {
        if (!coverTargetRule || !(target instanceof Element)) return false;
        if (document.documentElement?.getAttribute(COVER_PREVIEW_READY_ATTR) !== '1') return false;
        if (target.closest('.__mobile_preview_active__')) return true;
        return coverTargetRule(target);
    }

    function isNoNavLink(a) {
        return Boolean(noNavTargetRule && a && noNavTargetRule(a));
    }

    // 单一点击处理器：只在冒泡阶段处理，只取消浏览器默认导航，保留站点已执行的目标/document 处理器。
    function handleLinkClick(e) {
        if (!isPlainPrimaryClick(e)) return;
        if (toolbar?.contains(e.target)) return;

        // 先定位链接：绝大多数点击在这里就结束，不必再跑封面检测。
        const a = findLinkTarget(e.target);
        if (!a || a.dataset.tbInternalOpen === 'true') return;
        // 站点顶部标题/Logo：让它按网站原生行为在当前标签页返回主页，不新标签页打开也不拦截。
        if (isNoNavLink(a)) return;
        // 封面预览脚本存在时，封面点击交给它处理，标题点击仍直接新标签页打开。
        if (isCoverPreviewTarget(e.target)) return;

        const preview = getMissAvHiddenPreview(a);
        if (preview) {
            if (hasNativePreviewHandler(a, preview)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            activateMissAvPreview(preview);
            return;
        }

        const href = getBackgroundOpenUrl(a);
        if (!href) return;
        e.preventDefault();
        requestCheckedBackgroundOpen(href, a);
    }

    function handleBackgroundOpenRequest(event) {
        if (!enabled || event.detail?.source !== 'cover-video-preview') return;
        if (navigator.userActivation && !navigator.userActivation.isActive) return;
        let url;
        try { url = new URL(String(event.detail.href || ''), document.baseURI); } catch (_) { return; }
        if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return;
        // 封面预览脚本只会在它自己识别出的封面上发这个事件，不再额外限制链接路径。
        // 封面预览脚本在同一次真实用户点击中同步派发该事件（事件在 content/page 两个 world 间共享）。
        // 用户激活仍在调用栈上，直接新标签页打开并跳转即可；不再依赖任何手势握手。
        event.preventDefault();
        requestCheckedBackgroundOpen(url.href, null);
    }

    function injectCSS() {
        const existingStyle = document.getElementById('__tb_style__');
        if (existingStyle === styleElement && styleElement?.isConnected) return;
        existingStyle?.remove?.();
        if (styleElement && styleElement !== existingStyle) styleElement.remove?.();
        const style = document.createElement('style');
        style.id = '__tb_style__';
        style.textContent = `
#__tb__{position:fixed;z-index:2147483647;width:${BTN_SIZE}px;height:${BTN_SIZE}px;box-sizing:border-box;touch-action:none;-webkit-touch-callout:none;user-select:none;-webkit-user-select:none;transform:translate3d(0,0,0);will-change:left,top,right,bottom,transform;}
#__tb_btn__{--combined-separator:rgba(60,60,67,.16);position:relative;width:${BTN_SIZE}px;height:${BTN_SIZE}px;box-sizing:border-box;border-radius:999px;background:#F2F2F7;color:rgba(28,28,30,.82);border:0;box-shadow:inset 0 0 0 .5px var(--combined-separator);filter:none;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity .2s,border-radius .12s ease;}
#__tb_btn__[data-connected-left="true"][data-connected-right="true"]{border-radius:0;box-shadow:inset 0 .5px 0 var(--combined-separator),inset 0 -.5px 0 var(--combined-separator);}
#__tb_btn__[data-connected-left="true"][data-connected-right="false"]{border-radius:0 999px 999px 0;box-shadow:inset -.5px 0 0 var(--combined-separator),inset 0 .5px 0 var(--combined-separator),inset 0 -.5px 0 var(--combined-separator);}
#__tb_btn__[data-connected-left="false"][data-connected-right="true"]{border-radius:999px 0 0 999px;box-shadow:inset .5px 0 0 var(--combined-separator),inset 0 .5px 0 var(--combined-separator),inset 0 -.5px 0 var(--combined-separator);}
#__tb_btn__[data-connected-left="true"]::before{content:"";position:absolute;z-index:2;left:0;top:7px;bottom:7px;width:1px;background:var(--combined-separator);pointer-events:none;}
#__tb_btn__[data-enabled="true"]{color:#0A84FF;}
#__tb_btn__ svg{pointer-events:none;stroke:currentColor;}
#__tb_btn__:active{transform:none;opacity:.94;background:#E5E5EA;}
#__tb_btn__[data-enabled="true"]:active{background:#E5E5EA;}
@media (prefers-color-scheme: dark){#__tb_btn__{--combined-separator:rgba(255,255,255,.16);background:#2C2C2E;color:rgba(255,255,255,.88);}#__tb_btn__[data-enabled="true"]{color:#64D2FF;}#__tb_btn__:active,#__tb_btn__[data-enabled="true"]:active{background:#3A3A3C;}}`;
        styleElement = style;
        const parent = document.head || document.documentElement || document.body;
        if (parent) parent.appendChild(style);
    }

    // SVG 链接图标：开关状态只通过 currentColor 区分，保持组合栏背景一致。
    function linkSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" fill="none"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" fill="none"></path></svg>';
    }

    function updateBtn() {
        if (!linkBtn) return;
        linkBtn.dataset.enabled = enabled ? 'true' : 'false';
        linkBtn.style.opacity = '1';
        linkBtn.title = enabled ? '新标签页打开：开' : '新标签页打开：关';
    }

    function getViewportBox() {
        const vv = window.visualViewport;
        const layoutWidth = document.documentElement.clientWidth || innerWidth || 0;
        const layoutHeight = document.documentElement.clientHeight || innerHeight || 0;
        return {
            width: Math.max(1, Math.floor(vv?.width || 0), Math.floor(layoutWidth), Math.floor(innerWidth || 0)),
            height: Math.max(1, Math.floor(vv?.height || 0), Math.floor(layoutHeight), Math.floor(innerHeight || 0)),
        };
    }

    // 纯 fixed：clamp 到视口内，不叠加 visualViewport offset，避免页面滑动时漂移。
    function clampPos(left, top) {
        const viewport = getViewportBox();
        return {
            left: Math.max(0, Math.min(left, viewport.width - BTN_SIZE)),
            top: Math.max(0, Math.min(top, viewport.height - BTN_SIZE - BOTTOM_GAP)),
        };
    }

    function clampToolbarGroupPos(left, top, toolbar) {
        const viewport = getViewportBox();
        const ownRect = toolbar?.getBoundingClientRect?.();
        const width = Math.max(toolbar?.offsetWidth || ownRect?.width || 0, BTN_SIZE);
        const height = Math.max(toolbar?.offsetHeight || ownRect?.height || 0, BTN_SIZE);
        const maxLeft = Math.max(0, viewport.width - width);
        const leftControl = document.getElementById(BOOKMARK_TOOLBAR_ID);
        const leftControlWidth = leftControl?.getBoundingClientRect?.().width || BTN_SIZE;
        const minLeft = Math.min(leftControlWidth, maxLeft);
        return {
            left: Math.max(minLeft, Math.min(left, maxLeft)),
            top: Math.max(0, Math.min(top, viewport.height - height - BOTTOM_GAP)),
        };
    }

    function dispatchGroupDrag(toolbar, phase, left, top) {
        if (!toolbar) return;
        toolbar.dispatchEvent(new CustomEvent(GROUP_DRAG_EVENT, { detail: { phase, left, top } }));
    }

    function applySavedPosition() {
        if (!toolbar || !savedPosition) return false;
        const pos = clampPos(savedPosition.left, savedPosition.top);
        savedPosition = pos;
        // 纯 fixed：直接用 left/top，不叠加 offset。
        lastAppliedLayout = null;
        toolbar.style.left = pos.left + 'px';
        toolbar.style.top = pos.top + 'px';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        return true;
    }

    // 悬浮工具栏保留兼容 DOM id：链接按钮直接贴在它左侧，形成一条视觉组合栏。
    const FLOATING_TOOLBAR_ID = 'universal-pagination-floating-menu';
    const BOOKMARK_TOOLBAR_ID = 'tab-save-toolbar';

    function controlsAreAdjacent(leftControl, rightControl) {
        if (!leftControl?.isConnected || !rightControl?.isConnected) return false;
        const leftRect = leftControl.getBoundingClientRect();
        const rightRect = rightControl.getBoundingClientRect();
        return leftRect.width > 0 && leftRect.height > 0 && rightRect.width > 0 && rightRect.height > 0 &&
            Math.abs(leftRect.right - rightRect.left) <= 1.5 && Math.abs(leftRect.top - rightRect.top) <= 1.5;
    }

    function refreshConnectedVisual() {
        if (!linkBtn?.isConnected || !toolbar?.isConnected) return;
        const bookmarkToolbar = document.getElementById(BOOKMARK_TOOLBAR_ID);
        const floatingToolbar = document.getElementById(FLOATING_TOOLBAR_ID);
        const connectedLeft = controlsAreAdjacent(bookmarkToolbar, toolbar);
        const connectedRight = controlsAreAdjacent(toolbar, floatingToolbar);
        linkBtn.dataset.connectedLeft = connectedLeft ? 'true' : 'false';
        linkBtn.dataset.connectedRight = connectedRight ? 'true' : 'false';
        const bookmarkButton = document.getElementById('tab-save-button');
        if (bookmarkButton) bookmarkButton.dataset.connectedRight = connectedLeft ? 'true' : 'false';
        if (floatingToolbar) floatingToolbar.dataset.connectedLeft = connectedRight ? 'true' : 'false';
    }

    function observeNeighbor(neighbor) {
        if (observedNeighbor === neighbor) return;
        neighborResizeObserver?.disconnect();
        neighborMutationObserver?.disconnect();
        observedNeighbor = neighbor || null;
        if (!neighbor) return;
        if (typeof ResizeObserver === 'function') {
            neighborResizeObserver = new ResizeObserver(schedulePositionStabilize);
            neighborResizeObserver.observe(neighbor);
        }
        if (typeof MutationObserver === 'function') {
            neighborMutationObserver = new MutationObserver(schedulePositionStabilize);
            neighborMutationObserver.observe(neighbor, { attributes: true, attributeFilter: ['style'] });
        }
    }

    // 默认位置：横向读取悬浮工具栏的实时 rect，把链接按钮无缝贴在其左侧；
    // 纵向始终使用 fixed bottom，不读取 rect.top，避免 iOS 过度滑动/地址栏伸缩时被临时 top 值带偏。
    // 若悬浮工具栏尚未创建，则使用保守 right/bottom 兜底。
    function writeToolbarLayout(left, top, bottom) {
        if (lastAppliedLayout &&
            lastAppliedLayout.left === left &&
            lastAppliedLayout.top === top &&
            lastAppliedLayout.bottom === bottom) return;
        lastAppliedLayout = { left, top, bottom };
        toolbar.style.left = left;
        toolbar.style.right = 'auto';
        toolbar.style.top = top;
        toolbar.style.bottom = bottom;
    }

    function applyDefaultPosition() {
        if (!toolbar) return;
        const viewport = getViewportBox();
        // 优先复用已观察的邻居引用，避免每次布局刷新都做 getElementById。
        let neighbor = observedNeighbor?.isConnected ? observedNeighbor : null;
        if (!neighbor) neighbor = document.getElementById(FLOATING_TOOLBAR_ID);
        observeNeighbor(neighbor);
        // 纵向用 CSS bottom 锚定贴底（不换算绝对 top），避免 iOS Safari 地址栏伸缩时
        // viewport.height 取到偏大的布局视口高度，把按钮顶到屏幕中间。
        const defaultRightLeft = Math.max(0, Math.floor(viewport.width - BTN_SIZE - DEFAULT_RIGHT));
        if (neighbor) {
            const rect = neighbor.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const pos = clampPos(rect.left - LINK_TOOLBAR_GAP - BTN_SIZE + CONNECT_OVERLAP, 0);
                const usesBottom = neighbor.style.bottom && neighbor.style.bottom !== 'auto' && (!neighbor.style.top || neighbor.style.top === 'auto');
                if (usesBottom) writeToolbarLayout(pos.left + 'px', 'auto', neighbor.style.bottom);
                else writeToolbarLayout(pos.left + 'px', rect.top + 'px', 'auto');
                return;
            }
        }
        writeToolbarLayout(defaultRightLeft + 'px', 'auto', DEFAULT_BOTTOM + 'px');
    }

    // 纯 fixed 定位：允许页面内临时拖动；刷新页面后恢复默认位置。

    function buildToolbar() {
        injectCSS();

        const parent = document.body || document.documentElement;
        if (!parent) return false;

        const oldToolbar = document.getElementById('__tb__');
        if (oldToolbar) oldToolbar.remove();
        if (toolbar && toolbar !== oldToolbar) toolbar.remove?.();

        toolbar = document.createElement('div');
        toolbar.id = '__tb__';

        linkBtn = document.createElement('div');
        linkBtn.id = '__tb_btn__';
        linkBtn.innerHTML = linkSVG();
        linkBtn.dataset.connectedLeft = 'false';
        linkBtn.dataset.connectedRight = 'false';
        toolbar.appendChild(linkBtn);
        isolateFloatingUi(toolbar);
        parent.appendChild(toolbar);

        savedPosition = null;
        lastAppliedLayout = null;
        applyDefaultPosition();

        updateBtn();
        linkBtn.addEventListener('pointerdown', onPointerDown);
        linkBtn.addEventListener('pointermove', onPointerMove);
        linkBtn.addEventListener('pointerup', onPointerUp);
        linkBtn.addEventListener('pointercancel', onPointerUp);
        return true;
    }

    function onPointerDown(e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = toolbar.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        dragNeighborToolbar = document.getElementById(FLOATING_TOOLBAR_ID);
        if (dragNeighborToolbar) {
            const neighborRect = dragNeighborToolbar.getBoundingClientRect();
            startNeighborLeft = neighborRect.left;
            startNeighborTop = neighborRect.top;
        }
        // 普通点击保持原有 bottom/top 锚定不变；只有移动超过阈值后才进入拖动定位。
        linkBtn.setPointerCapture?.(e.pointerId);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        e.preventDefault();
        e.stopPropagation();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        moved = true;

        if (dragNeighborToolbar) {
            const pos = clampToolbarGroupPos(startNeighborLeft + dx, startNeighborTop + dy, dragNeighborToolbar);
            dispatchGroupDrag(dragNeighborToolbar, 'move', pos.left, pos.top);
            applyDefaultPosition();
        } else {
            // 悬浮工具栏未加载时，仍允许链接按钮独立拖动。
            const pos = clampPos(startLeft + dx, startTop + dy);
            lastAppliedLayout = null;
            toolbar.style.left = pos.left + 'px';
            toolbar.style.top = pos.top + 'px';
            toolbar.style.right = 'auto';
            toolbar.style.bottom = 'auto';
        }
    }

    function onPointerUp(e) {
        if (!dragging) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
        requestRefresh(REFRESH_LAYOUT);
        linkBtn.releasePointerCapture?.(e.pointerId);

        if (moved && dragNeighborToolbar) {
            const rect = dragNeighborToolbar.getBoundingClientRect();
            dispatchGroupDrag(dragNeighborToolbar, e.type === 'pointercancel' ? 'cancel' : 'end', rect.left, rect.top);
            savedPosition = null;
        } else if (moved) {
            // 悬浮工具栏未加载时仅保留本页面内的临时位置。
            savedPosition = clampPos(parseInt(toolbar.style.left, 10) || 0, parseInt(toolbar.style.top, 10) || 0);
        } else if (e.type !== 'pointercancel') {
            enabledRevision += 1;
            enabled = !enabled;
            saveEnabledState();
            requestRefresh(REFRESH_CONTENT);
        }
        dragNeighborToolbar = null;
    }

    function isToolbarHealthy() {
        const existingToolbar = document.getElementById('__tb__');
        const existingBtn = document.getElementById('__tb_btn__');
        const existingStyle = document.getElementById('__tb_style__');
        return Boolean(existingToolbar === toolbar && existingBtn === linkBtn && existingStyle === styleElement && styleElement?.isConnected && existingToolbar && existingBtn && existingToolbar.contains(existingBtn) && document.documentElement.contains(existingToolbar));
    }

    function ensureToolbar() {
        const existing = document.getElementById('__tb__');
        const btn = document.getElementById('__tb_btn__');
        const body = document.body;
        if (isToolbarHealthy() && existing && btn && toolbar === existing && linkBtn === btn) {
            hookHistoryForUrlChange();
            // document-start 时可能先挂到 <html>；body 出现后立刻挪进去，避免部分站点重写根节点导致按钮丢失。
            if (body && existing.parentNode !== body) body.appendChild(existing);
            return true;
        }
        return buildToolbar();
    }

    function scheduleEnsureToolbar() {
        requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
    }

    const FLOATING_UI_SELECTOR = '#__tb__, #__tb_btn__, #__tb_style__, #' + FLOATING_TOOLBAR_ID + ', #' + BOOKMARK_TOOLBAR_ID;

    function mutationTouchesFloatingUi(mutation) {
        const nodes = Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes));
        return nodes.some(function (node) {
            if (!(node instanceof Element)) return false;
            if (node.tagName === 'HEAD' || node.tagName === 'BODY') return true;
            return node.matches?.(FLOATING_UI_SELECTOR) || Boolean(node.querySelector?.(FLOATING_UI_SELECTOR));
        });
    }

    function startBodyGuard() {
        if (bodyObserver) return;
        bodyObserver = new MutationObserver(function (mutations) {
            if (!mutations.some(mutationTouchesFloatingUi)) return;
            // 相关节点变化才调度一次轻量健康检查；不扫描普通页面内容。
            requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
        });
        bodyObserver.observe(document, { childList: true, subtree: true });
    }

    function schedulePositionStabilize() {
        // 滞后已有待处理的布局刷新时直接短路，iOS 滞后滚动中不重复进入调度。
        if (refreshFrame != null && (pendingRefreshFlags & REFRESH_LAYOUT)) return;
        requestRefresh(REFRESH_LAYOUT);
    }

    function recoverRefresh() {
        refreshRetryCount = 0;
        requestRefresh(REFRESH_FULL);
    }

    function installPositionListenersOnce() {
        if (listenersInstalled) return;
        listenersInstalled = true;
        const stabilizePosition = schedulePositionStabilize;
        window.addEventListener('resize', stabilizePosition);
        window.addEventListener('scroll', stabilizePosition, { passive: true });
        window.visualViewport?.addEventListener('resize', stabilizePosition);
        window.visualViewport?.addEventListener('scroll', stabilizePosition);
        window.addEventListener(SHARED_URL_CHANGE_EVENT, scheduleUrlRefresh);
        hookHistoryForUrlChange();
        window.addEventListener('pageshow', recoverRefresh);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) recoverRefresh(); });
        window.addEventListener('focus', recoverRefresh);
    }

    function scheduleUrlRefresh() {
        if (location.href === lastHref) return;
        lastHref = location.href;
        currentUrlParts = null;
        requestRefresh(REFRESH_FULL);
    }

    function dispatchSharedUrlChange(kind) {
        const shared = window[SHARED_HISTORY_HOOK_KEY];
        if (shared) shared.sequence = Number(shared.sequence || 0) + 1;
        window.dispatchEvent(new CustomEvent(SHARED_URL_CHANGE_EVENT, { detail: { kind, href: location.href } }));
    }

    function hookHistoryForUrlChange() {
        const shared = window[SHARED_HISTORY_HOOK_KEY];
        const wrappersValid = ['pushState', 'replaceState'].every(function (name) {
            return typeof history[name] === 'function' && history[name] === shared?.wrappers?.[name] && history[name].__urlChangeEvent === SHARED_URL_CHANGE_EVENT;
        });
        if (shared?.eventName === SHARED_URL_CHANGE_EVENT && wrappersValid) return;
        const wrappers = {};
        ['pushState', 'replaceState'].forEach(function (name) {
            const original = history[name];
            if (typeof original !== 'function') return;
            const wrapped = function () {
                const sequence = Number(window[SHARED_HISTORY_HOOK_KEY]?.sequence || 0);
                const result = original.apply(this, arguments);
                if (Number(window[SHARED_HISTORY_HOOK_KEY]?.sequence || 0) === sequence) dispatchSharedUrlChange(name);
                return result;
            };
            try { Object.defineProperty(wrapped, '__urlChangeEvent', { value: SHARED_URL_CHANGE_EVENT }); } catch (_) {}
            try { history[name] = wrapped; } catch (_) {}
            wrappers[name] = history[name] === wrapped ? wrapped : history[name];
        });
        const handlers = shared?.handlers || {
            popstate: function () { dispatchSharedUrlChange('popstate'); },
            hashchange: function () { dispatchSharedUrlChange('hashchange'); }
        };
        if (!shared?.handlers) {
            window.addEventListener('popstate', handlers.popstate);
            window.addEventListener('hashchange', handlers.hashchange);
        }
        try { window[SHARED_HISTORY_HOOK_KEY] = { version: 2, eventName: SHARED_URL_CHANGE_EVENT, wrappers, handlers, sequence: Number(shared?.sequence || 0) }; } catch (_) {}
    }

    function init() {
        requestRefresh(REFRESH_FULL);
        return true;
    }

    async function start() {
        window.addEventListener(BACKGROUND_OPEN_REQUEST_EVENT, handleBackgroundOpenRequest);
        // 捕获阶段监听器已移除。如果某个站点在冒泡阶段追加当前页跳转或
        // 广告弹窗，只能可能拦不住，需要重新启用抢先拦截。
        window.addEventListener('click', handleLinkClick);

        // document-start 先创建基础按钮；GM 状态读取完成后只刷新开关外观，避免存储延迟阻塞 UI。
        requestRefresh(REFRESH_FULL);
        await loadEnabledState();
        requestRefresh(REFRESH_CONTENT);
        installEnabledStateListener();
    }

    INSTANCE.resume = function () {
        try {
            refreshRetryCount = 0;
            requestRefresh(REFRESH_FULL);
        } catch (_) {
            INSTANCE.phase = 'failed';
            scheduleEnsureToolbar();
        }
    };
    void start().catch(function () {
        INSTANCE.phase = 'failed';
        scheduleEnsureToolbar();
    });
})();
