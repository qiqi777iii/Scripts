// ==UserScript==
// @name         新标签页打开
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      2.2.9
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/new-tab-opener.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/new-tab-opener.user.js
// @description  在网页显示悬浮开关，并可在扩展面板设置链接的新标签页打开模式。
// @match        *://*/*
// @grant        GM.openInTab
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.addValueChangeListener
// @grant        GM.registerMenuCommand
// @grant        GM.unregisterMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = '__newTabOpenerInstanceV1__';
    const previousInstance = document[INSTANCE_KEY];
    // 旧实例的闭包可能已随页面重写失效；resume 抛错或未确认成功时必须继续完整启动，
    // 否则这次注入会直接 return，页面上再没有任何调度器，只能靠用户手动刷新。
    if (previousInstance?.resume) {
        let resumed = false;
        try {
            resumed = previousInstance.resume('reinjected') === true;
        } catch (_) {
            resumed = false;
        }
        if (resumed) return;
        try { document[INSTANCE_KEY] = null; } catch (_) {}
    }
    const INSTANCE = { phase: 'starting', resume: null };
    document[INSTANCE_KEY] = INSTANCE;

    const KEY = '__tb_';
    const SHARED_ENABLED_KEY_PREFIX = 'newTabEnabledBySite:';
    const SHARED_MODE_KEY_PREFIX = 'newTabModeBySite:';
    // nodeseek 页面缩放为 100%，其余站点按 85% 缩放，按钮尺寸与右边距需单独适配。
    const IS_NODESEEK = /(^|\.)nodeseek\.com$/i.test(location.hostname);
    const BTN_SIZE = IS_NODESEEK ? 32 : 40;
    const BOTTOM_GAP = IS_NODESEEK ? 50 : 60;
    const RIGHT_GAP = IS_NODESEEK ? 97 : 105;
    const SHARED_URL_CHANGE_EVENT = 'scripts:urlchange';
    const SHARED_HISTORY_HOOK_KEY = '__sharedHistoryHookV1__';
    // 组合胶囊标记：两个悬浮按钮都停在各自默认位置时，才在 <html> 上同时出现两个标记，
    // 由纯 CSS 把相邻的一侧拉直拼成胶囊；任一脚本未安装或被拖走时标记缺失，各自仍是独立圆钮。
    const DOCK_FLAG_SELF = 'fabNewTab';
    const DOCK_COMBINED_SELECTOR = 'html[data-fab-new-tab="docked"][data-fab-tab-save="docked"]';
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
    const MODE_BACKGROUND = 'background';
    const MODE_FOREGROUND = 'foreground';
    let openMode = normalizeOpenMode(getVal('newTabMode', MODE_BACKGROUND));
    let modeRevision = 0;
    const sharedSiteKey = getSharedSiteKey(location.hostname);
    const sharedEnabledKey = SHARED_ENABLED_KEY_PREFIX + sharedSiteKey;
    const sharedModeKey = SHARED_MODE_KEY_PREFIX + sharedSiteKey;
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
    let toolbar, linkBtn, styleElement, backgroundHint, backgroundHintTimer, bodyObserver;
    let listenersInstalled = false;
    let lastHref = location.href;
    let initRetryTimer = null;
    let refreshRetryCount = 0;
    let pendingRefreshFlags = 0;
    let refreshFrame = null;
    let refreshFallbackTimer = null;
    let refreshToken = 0;
    let idleProbeInstalled = false;
    // 页面内临时位置；刷新页面后变量会重建并恢复默认位置。
    let savedPosition = null;
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    let enabledValueChangeListenerInstalled = false;
    let modeValueChangeListenerInstalled = false;
    let modeMenuCommandIds = [];

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

    function normalizeOpenMode(value) {
        return value === MODE_FOREGROUND ? MODE_FOREGROUND : MODE_BACKGROUND;
    }

    async function loadModeState() {
        const revision = modeRevision;
        const localValue = normalizeOpenMode(getVal('newTabMode', MODE_BACKGROUND));
        let nextValue = localValue;
        if (typeof GM !== 'undefined' && GM.getValue) {
            try {
                const sharedValue = await GM.getValue(sharedModeKey, null);
                nextValue = sharedValue === null ? localValue : normalizeOpenMode(sharedValue);
                if (sharedValue === null && GM.setValue) await GM.setValue(sharedModeKey, nextValue);
            } catch (_) {
                nextValue = localValue;
            }
        }
        if (revision !== modeRevision) return;
        openMode = nextValue;
        setVal('newTabMode', openMode);
    }

    function saveModeState() {
        setVal('newTabMode', openMode);
        if (typeof GM === 'undefined' || !GM.setValue) return;
        try {
            const result = GM.setValue(sharedModeKey, openMode);
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
        if (enabledValueChangeListenerInstalled || typeof GM === 'undefined' || !GM.addValueChangeListener) return;
        enabledValueChangeListenerInstalled = true;
        GM.addValueChangeListener(sharedEnabledKey, function (_key, _oldValue, newValue) {
            if (typeof newValue !== 'boolean' || newValue === enabled) return;
            enabledRevision += 1;
            enabled = newValue;
            setVal('newTabEnabled', enabled);
            requestRefresh(REFRESH_CONTENT);
        });
    }

    function installModeStateListener() {
        if (modeValueChangeListenerInstalled || typeof GM === 'undefined' || !GM.addValueChangeListener) return;
        modeValueChangeListenerInstalled = true;
        GM.addValueChangeListener(sharedModeKey, function (_key, _oldValue, newValue) {
            const nextMode = normalizeOpenMode(newValue);
            if (nextMode === openMode) return;
            modeRevision += 1;
            openMode = nextMode;
            setVal('newTabMode', openMode);
            registerModeMenuCommands();
            requestRefresh(REFRESH_CONTENT);
        });
    }

    function setOpenMode(nextMode) {
        const normalizedMode = normalizeOpenMode(nextMode);
        if (normalizedMode === openMode) return;
        modeRevision += 1;
        openMode = normalizedMode;
        saveModeState();
        registerModeMenuCommands();
        requestRefresh(REFRESH_CONTENT);
    }

    function registerModeMenuCommands() {
        if (typeof GM === 'undefined' || typeof GM.registerMenuCommand !== 'function') return;
        if (typeof GM.unregisterMenuCommand === 'function') {
            modeMenuCommandIds.forEach(function (id) {
                try { GM.unregisterMenuCommand(id); } catch (_) {}
            });
        }
        modeMenuCommandIds = [];
        const backgroundTitle = (openMode === MODE_BACKGROUND ? '✓ ' : '') + '模式 1：后台打开，不跳转';
        const foregroundTitle = (openMode === MODE_FOREGROUND ? '✓ ' : '') + '模式 2：新标签页打开并跳转';
        modeMenuCommandIds.push(GM.registerMenuCommand(backgroundTitle, function () {
            setOpenMode(MODE_BACKGROUND);
        }, { autoClose: true, title: '新标签页打开模式' }));
        modeMenuCommandIds.push(GM.registerMenuCommand(foregroundTitle, function () {
            setOpenMode(MODE_FOREGROUND);
        }, { autoClose: true, title: '新标签页打开模式' }));
    }

    const REFRESH_STRUCTURE = 1;
    const REFRESH_CONTENT = 2;
    const REFRESH_LAYOUT = 4;
    const REFRESH_FULL = REFRESH_STRUCTURE | REFRESH_CONTENT | REFRESH_LAYOUT;
    const REFRESH_RETRY_DELAYS = [250, 1000, 3000, 10000, 30000];

    // 只在实际构建失败时无限退避重试，最长每 30 秒一次；正常状态没有轮询。
    function scheduleRefreshRetry() {
        if (document.hidden || initRetryTimer) return;
        const delay = REFRESH_RETRY_DELAYS[Math.min(refreshRetryCount++, REFRESH_RETRY_DELAYS.length - 1)];
        initRetryTimer = setTimeout(function () {
            initRetryTimer = null;
            requestRefresh(REFRESH_FULL);
        }, delay);
    }

    function cancelPendingRefreshSchedule() {
        refreshToken += 1;
        if (refreshFrame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(refreshFrame);
        if (refreshFallbackTimer != null) clearTimeout(refreshFallbackTimer);
        refreshFrame = null;
        refreshFallbackTimer = null;
    }

    function requestRefresh(flags = REFRESH_FULL) {
        pendingRefreshFlags |= flags;
        if ((document.hidden && INSTANCE.phase !== 'starting') || refreshFrame != null || refreshFallbackTimer != null) return;
        const token = ++refreshToken;
        let completed = false;
        const run = function () {
            if (completed || token !== refreshToken) return;
            completed = true;
            if (refreshFrame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(refreshFrame);
            if (refreshFallbackTimer != null) clearTimeout(refreshFallbackTimer);
            refreshFrame = null;
            refreshFallbackTimer = null;
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
                    // 早期 return 会跳过 phase 收尾，让实例永远停在 starting/failed。
                    if (toolbar && !dragging) {
                        if (savedPosition) applySavedPosition();
                        else applyDefaultPosition();
                        toolbar.style.transform = 'translate3d(0,0,0)';
                    }
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
        if (typeof requestAnimationFrame === 'function') {
            refreshFrame = requestAnimationFrame(run);
            refreshFallbackTimer = setTimeout(run, 240);
        } else {
            refreshFallbackTimer = setTimeout(run, 16);
        }
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

    function showBackgroundOpenHint() {
        const parent = document.body || document.documentElement;
        if (!parent) return;
        if (!backgroundHint?.isConnected) {
            backgroundHint = document.createElement('div');
            backgroundHint.id = '__tb_background_hint__';
            backgroundHint.textContent = '已在后台打开新标签页';
            parent.appendChild(backgroundHint);
        }
        if (backgroundHintTimer) clearTimeout(backgroundHintTimer);
        backgroundHint.dataset.visible = 'true';
        backgroundHintTimer = setTimeout(function () {
            if (backgroundHint) backgroundHint.dataset.visible = 'false';
            backgroundHintTimer = null;
        }, 1400);
    }

    function openLinkInConfiguredMode(href) {
        if (!href) return;
        try {
            if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
                const shouldActivate = openMode === MODE_FOREGROUND;
                const task = GM.openInTab(href, {
                    active: shouldActivate,
                    loadInBackground: !shouldActivate
                });
                if (task && typeof task.then === 'function') {
                    task.then(function () {
                        if (!shouldActivate) showBackgroundOpenHint();
                    }).catch(function () { openLinkWithAnchor(href); });
                } else if (!shouldActivate) {
                    showBackgroundOpenHint();
                }
                return;
            }
        } catch (_) {}
        openLinkWithAnchor(href);
    }

    function requestCheckedNewTabOpen(href, sourceLink) {
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
        if (!event.defaultPrevented) openLinkInConfiguredMode(href);
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

    function shouldUseNativeNavigation(a) {
        if (!a) return false;
        // Eporner 顶部搜索建议属于站内搜索流程，必须沿用当前标签页导航。
        if (sharedSiteKey === 'eporner.com' && a.closest('#searcharea, #quicksearch')) return true;
        // SpankBang 的 /s/ 是移动端导航/账户面板；其入口依赖当前页原生点击流程。
        // 在这里统一保留站点行为，避免后台打开模式让菜单看起来完全没有响应。
        return sharedSiteKey === 'spankbang.com' && /^\/s\/?$/i.test(location.pathname);
    }

    function keepEpornerSearchInCurrentTab(event) {
        if (sharedSiteKey !== 'eporner.com') return;
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.matches('#forma')) return;
        let action;
        try { action = new URL(form.action || '/search/', document.baseURI); } catch (_) { return; }
        if (action.origin !== location.origin || !/^\/search\/?$/i.test(action.pathname)) return;
        form.setAttribute('target', '_self');
    }

    function getNewTabOpenUrl(a) {
        // 排序按「代价低、淘汰率高」优先：href 快速判空 → URL 解析 →
        // 站点规则 → 交互链接 → 敏感链接 → 翻页链接（最贵，需向上遍历 DOM）。
        if (!enabled || !a || a.dataset.tbInternalOpen === 'true') return null;
        if (shouldUseNativeNavigation(a)) return null;
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

        const href = getNewTabOpenUrl(a);
        if (!href) return;
        e.preventDefault();
        requestCheckedNewTabOpen(href, a);
    }

    function handleBackgroundOpenRequest(event) {
        if (!enabled || event.detail?.source !== 'cover-video-preview') return;
        if (navigator.userActivation && !navigator.userActivation.isActive) return;
        let url;
        try { url = new URL(String(event.detail.href || ''), document.baseURI); } catch (_) { return; }
        if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return;
        // 封面预览脚本只会在它自己识别出的封面上发这个事件，不再额外限制链接路径。
        // 封面预览脚本在同一次真实用户点击中同步派发该事件（事件在 content/page 两个 world 间共享）。
        // 用户激活仍在调用栈上，按当前模式在后台打开或打开后立即跳转；不再依赖任何手势握手。
        event.preventDefault();
        requestCheckedNewTabOpen(url.href, null);
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
#__tb_btn__{position:relative;width:${BTN_SIZE}px;height:${BTN_SIZE}px;box-sizing:border-box;border-radius:999px;background:#F2F2F7;color:rgba(28,28,30,.82);border:0;box-shadow:inset 0 0 0 .5px rgba(60,60,67,.16);filter:none;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity .2s;}
#__tb_btn__[data-enabled="true"]{color:#0A84FF;}
#__tb_btn__ svg{display:block;width:60%;height:60%;flex:none;pointer-events:none;stroke:currentColor;}
#__tb_btn__:active{transform:none;opacity:.94;background:#E5E5EA;}
#__tb_btn__[data-enabled="true"]:active{background:#E5E5EA;}
${DOCK_COMBINED_SELECTOR} #__tb_btn__{border-radius:999px 0 0 999px;}
#__tb_background_hint__{position:fixed;z-index:2147483647;left:50%;bottom:96px;max-width:calc(100vw - 40px);box-sizing:border-box;padding:9px 14px;border-radius:999px;background:rgba(28,28,30,.88);color:#fff;font:600 14px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transform:translate3d(-50%,8px,0);transition:opacity .16s ease,transform .16s ease;}
#__tb_background_hint__[data-visible="true"]{opacity:1;transform:translate3d(-50%,0,0);}
@media (prefers-reduced-motion:reduce){#__tb_background_hint__{transition:none;}}
@media (prefers-color-scheme: dark){#__tb_btn__{--combined-separator:rgba(255,255,255,.16);background:#2C2C2E;color:rgba(255,255,255,.88);}#__tb_btn__[data-enabled="true"]{color:#64D2FF;}#__tb_btn__:active,#__tb_btn__[data-enabled="true"]:active{background:#3A3A3C;}}`;
        styleElement = style;
        const parent = document.head || document.documentElement || document.body;
        if (parent) parent.appendChild(style);
    }

    // SVG 链接图标：开关状态只通过 currentColor 区分，保持组合栏背景一致。
    function linkSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" fill="none"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" fill="none"></path></svg>';
    }

    function updateBtn() {
        if (!linkBtn) return;
        linkBtn.dataset.enabled = enabled ? 'true' : 'false';
        linkBtn.style.opacity = '1';
        const modeName = openMode === MODE_BACKGROUND ? '后台打开不跳转' : '打开后立即跳转';
        linkBtn.title = enabled ? '新标签页打开：开（' + modeName + '）' : '新标签页打开：关';
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

    function setDockFlag(docked) {
        try {
            const root = document.documentElement;
            if (!root) return;
            if (docked) root.dataset[DOCK_FLAG_SELF] = 'docked';
            else delete root.dataset[DOCK_FLAG_SELF];
        } catch (_) {}
    }

    function applySavedPosition() {
        if (!toolbar || !savedPosition) return false;
        setDockFlag(false);
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

    // 独立固定按钮，不读取、跟随、拼接或广播其他悬浮组件。
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
        setDockFlag(true);
        lastAppliedLayout = null;
        toolbar.style.left = 'auto';
        toolbar.style.top = 'auto';
        toolbar.style.right = RIGHT_GAP + 'px';
        toolbar.style.bottom = BOTTOM_GAP + 'px';
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
        setDockFlag(false);

        const pos = clampPos(startLeft + dx, startTop + dy);
        lastAppliedLayout = null;
        toolbar.style.left = pos.left + 'px';
        toolbar.style.top = pos.top + 'px';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
    }

    function onPointerUp(e) {
        if (!dragging) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = false;
        requestRefresh(REFRESH_LAYOUT);
        linkBtn.releasePointerCapture?.(e.pointerId);

        if (moved) {
            // 拖动位置仅保留在当前页面生命周期。
            savedPosition = clampPos(parseInt(toolbar.style.left, 10) || 0, parseInt(toolbar.style.top, 10) || 0);
        } else if (e.type !== 'pointercancel') {
            enabledRevision += 1;
            enabled = !enabled;
            saveEnabledState();
            requestRefresh(REFRESH_CONTENT);
        }
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

    const FLOATING_UI_SELECTOR = '#__tb__, #__tb_btn__, #__tb_style__';

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
        if ((refreshFrame != null || refreshFallbackTimer != null) && (pendingRefreshFlags & REFRESH_LAYOUT)) return;
        requestRefresh(REFRESH_LAYOUT);
    }

    // 节点存在不等于真的可见：站点样式可能把它压成零尺寸或隐藏。
    function elementVisible(element) {
        if (!element?.isConnected) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function toolbarPresent() {
        return isToolbarHealthy() && elementVisible(document.getElementById('__tb__'));
    }

    // 用户真正看到页面的那一刻必查一次；once 监听，几乎无开销。
    function installIdleProbeOnce() {
        if (idleProbeInstalled) return;
        idleProbeInstalled = true;
        const probe = function () {
            if (!document.hidden && !toolbarPresent()) requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
        };
        const options = { once: true, passive: true, capture: true };
        window.addEventListener('pointerdown', probe, options);
    }

    function recoverRefresh() {
        refreshRetryCount = 0;
        if (initRetryTimer) {
            clearTimeout(initRetryTimer);
            initRetryTimer = null;
        }
        cancelPendingRefreshSchedule();
        requestRefresh(REFRESH_FULL);
    }

    // 前台恢复时按事件立即校验；MutationObserver 持续守护 DOM，不使用定时存在性轮询。
    function scheduleWakeRecovery() {
        if (!document.hidden) recoverRefresh();
    }

    function installPositionListenersOnce() {
        if (listenersInstalled) return;
        listenersInstalled = true;
        const stabilizePosition = schedulePositionStabilize;
        window.addEventListener('resize', stabilizePosition);
        window.visualViewport?.addEventListener('resize', stabilizePosition);
        window.addEventListener(SHARED_URL_CHANGE_EVENT, scheduleUrlRefresh);
        hookHistoryForUrlChange();
        window.addEventListener('pageshow', scheduleWakeRecovery);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) scheduleWakeRecovery(); });
        window.addEventListener('focus', scheduleWakeRecovery);
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

    async function start() {
        window.addEventListener(BACKGROUND_OPEN_REQUEST_EVENT, handleBackgroundOpenRequest);
        // 捕获阶段监听器已移除。如果某个站点在冒泡阶段追加当前页跳转或
        // 广告弹窗，只能可能拦不住，需要重新启用抢先拦截。
        window.addEventListener('click', handleLinkClick);
        window.addEventListener('submit', keepEpornerSearchInCurrentTab, true);

        // 页面 DOM 构建完成后创建按钮并安装链接监听，避免站点初始化时重写根节点导致按钮丢失。
        installPositionListenersOnce();
        requestRefresh(REFRESH_FULL);
        installIdleProbeOnce();
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', recoverRefresh, { once: true });
        if (document.readyState !== 'complete') window.addEventListener('load', recoverRefresh, { once: true });
        await Promise.all([loadEnabledState(), loadModeState()]);
        registerModeMenuCommands();
        requestRefresh(REFRESH_CONTENT);
        installEnabledStateListener();
        installModeStateListener();
    }

    // resume 必须同步给出真实结果：若交给异步调度再返回 false，
    // 新注入的实例会与仍在监听的旧实例同时重建工具栏，互相抢节点。
    INSTANCE.resume = function () {
        refreshRetryCount = 0;
        if (initRetryTimer) {
            clearTimeout(initRetryTimer);
            initRetryTimer = null;
        }
        cancelPendingRefreshSchedule();
        pendingRefreshFlags = 0;
        try {
            installPositionListenersOnce();
            hookHistoryForUrlChange();
            ensureToolbar();
            startBodyGuard();
            updateBtn();
            if (toolbar && !dragging) {
                if (savedPosition) applySavedPosition();
                else applyDefaultPosition();
            }
            INSTANCE.phase = 'running';
        } catch (_) {
            INSTANCE.phase = 'failed';
            scheduleEnsureToolbar();
            return false;
        }
        installIdleProbeOnce();
        return toolbarPresent();
    };
    void start().catch(function () {
        INSTANCE.phase = 'failed';
        scheduleEnsureToolbar();
    });
})();
