// ==UserScript==
// @name         MissAV浏览记录
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/missav-browsing-history.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/missav-browsing-history.user.js
// @description  识别 Safari 中当前及曾经打开的 MissAV 视频，并标记网页中的对应视频链接。
// @include      /^https?:\/\/(?:[^/]+\.)?missav\.[a-z]{2,}(?:[/?#]|$)/
// @grant        Scripting.tabs
// @grant        Scripting.FileManager
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const MARK_ATTR = 'data-open-video-tab';
    const HISTORY_ATTR = 'data-open-video-history';
    const LEGACY_HISTORY_KEY = 'tab-checker:missav-history:v1';
    const MIGRATION_KEY = 'tab-checker:shared-history-migrated:v1';
    const TITLE_BACKFILL_KEY = 'tab-checker:title-backfill:v1';
    const HISTORY_FILE_NAME = 'video-open-history-v1.json';
    const HISTORY_LIMIT = 5000;
    const STORE_VERSION = 2;
    const STYLE_ID = 'open-video-tab-style';
    const VIDEO_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i;
    const REFRESH_INTERVAL = 1500;
    const FULL_SCAN_THRESHOLD = 120;

    let openCodes = new Set();
    let historyCodes = new Set();
    let storeCache = null;
    let scanFrame = 0;
    let fullScanPending = false;
    let pendingRoots = new Set();
    let refreshTimer = 0;
    let lastRefreshAt = 0;
    let refreshing = false;
    let writeQueue = Promise.resolve();
    const parsedLinks = new WeakMap();

    function isMissAvHost(hostname) {
        return /(^|\.)missav\./i.test(String(hostname || ''));
    }

    function videoCodeFromUrl(value) {
        const raw = String(value || '');
        if (!raw) return null;
        try {
            const url = new URL(raw, document.baseURI);
            if (!/^https?:$/.test(url.protocol) || !isMissAvHost(url.hostname)) return null;
            const segments = url.pathname.split('/');
            let code = '';
            for (let i = segments.length - 1; i >= 0; i -= 1) {
                if (segments[i]) { code = segments[i]; break; }
            }
            return VIDEO_CODE_RE.test(code) ? code.toLowerCase() : null;
        } catch (_) {
            return null;
        }
    }

    function emptyStore() {
        return { version: STORE_VERSION, records: {} };
    }

    function getFileManager() {
        return typeof Scripting !== 'undefined' && Scripting.FileManager
            ? Scripting.FileManager
            : null;
    }

    function sharedHistoryPath() {
        const manager = getFileManager();
        const directory = manager?.safariBrowserDirectory;
        return directory ? `${directory}/${HISTORY_FILE_NAME}` : null;
    }

    function cleanTitle(value, code) {
        const title = String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*[-|–—]\s*MissAV.*$/i, '')
            .trim();
        return title && title.toLowerCase() !== String(code || '').toLowerCase()
            ? title.slice(0, 300)
            : '';
    }

    function normalizeRecord(codeKey, value) {
        const code = String(codeKey || '').toLowerCase();
        if (!VIDEO_CODE_RE.test(code)) return null;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return { code, url: `https://missav.ai/${code}`, t: value > 0 ? value : 0 };
        }
        if (!value || typeof value !== 'object') return null;
        const title = cleanTitle(value.title, code);
        const time = Number(value.t);
        return {
            code,
            url: typeof value.url === 'string' && /^https?:\/\//i.test(value.url)
                ? value.url
                : `https://missav.ai/${code}`,
            title: title || undefined,
            t: Number.isFinite(time) && time > 0 ? time : 0
        };
    }

    function normalizeStore(value) {
        const store = emptyStore();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return store;
        const source = value.records && typeof value.records === 'object' && !Array.isArray(value.records)
            ? value.records
            : value;
        const records = Object.entries(source)
            .map(function (entry) { return normalizeRecord(entry[0], entry[1]); })
            .filter(Boolean);
        // 旧数据没有时间戳，按原有的“最新在前”顺序回填，保证排序与裁剪稳定。
        let cursor = Date.now();
        records.forEach(function (record) {
            if (!record.t) {
                cursor -= 1000;
                record.t = cursor;
            }
        });
        pruneRecords(records).forEach(function (record) { store.records[record.code] = record; });
        return store;
    }

    function pruneRecords(records) {
        return records
            .filter(function (record) { return record && VIDEO_CODE_RE.test(record.code); })
            .sort(function (a, b) { return b.t - a.t; })
            .slice(0, HISTORY_LIMIT);
    }

    function syncHistoryCodes(store) {
        const codes = Object.keys(store.records);
        if (codes.length === historyCodes.size) {
            let same = true;
            for (const code of codes) {
                if (!historyCodes.has(code)) { same = false; break; }
            }
            if (same) return false;
        }
        historyCodes = new Set(codes);
        return true;
    }

    async function readSharedStore() {
        const manager = getFileManager();
        const path = sharedHistoryPath();
        if (!manager || !path) return emptyStore();
        try {
            if (!(await manager.exists(path))) return emptyStore();
            return normalizeStore(JSON.parse(await manager.readAsString(path, 'utf8')));
        } catch (_) {
            await new Promise(function (resolve) { setTimeout(resolve, 60); });
            try {
                return normalizeStore(JSON.parse(await manager.readAsString(path, 'utf8')));
            } catch (_) {
                return emptyStore();
            }
        }
    }

    async function getStore(forceReload) {
        if (!forceReload && storeCache) return storeCache;
        storeCache = await readSharedStore();
        syncHistoryCodes(storeCache);
        return storeCache;
    }

    async function writeSharedStore(store) {
        const manager = getFileManager();
        const path = sharedHistoryPath();
        if (!manager || !path) throw new Error('Scripting.FileManager is unavailable');
        const records = pruneRecords(Object.values(store.records));
        const next = { version: STORE_VERSION, records: {} };
        records.forEach(function (record) { next.records[record.code] = record; });
        await manager.writeAsString(path, JSON.stringify(next), 'utf8');
        storeCache = next;
        syncHistoryCodes(next);
        return next;
    }

    function mergeLegacyHistory(store) {
        let changed = false;
        try {
            if (localStorage.getItem(MIGRATION_KEY) === 'true') return false;
            const legacy = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) || '{}');
            if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
                Object.entries(legacy).forEach(function (entry) {
                    const record = normalizeRecord(entry[0], entry[1]);
                    if (!record || store.records[record.code]) return;
                    if (!record.t) record.t = 1;
                    store.records[record.code] = record;
                    changed = true;
                });
            }
            const titles = JSON.parse(localStorage.getItem(TITLE_BACKFILL_KEY) || '{}');
            if (titles && typeof titles === 'object' && !Array.isArray(titles)) {
                Object.entries(titles).forEach(function (entry) {
                    const code = String(entry[0] || '').toLowerCase();
                    const title = cleanTitle(entry[1], code);
                    if (store.records[code] && title && !store.records[code].title) {
                        store.records[code].title = title;
                        changed = true;
                    }
                });
            }
        } catch (_) {
            return false;
        }
        return changed;
    }

    async function loadHistory() {
        const store = await getStore(true);
        let changed = mergeLegacyHistory(store);
        if (store.version !== STORE_VERSION) changed = true;
        if (changed) {
            try {
                await writeSharedStore(store);
            } catch (_) {
                syncHistoryCodes(store);
            }
        }
        try { localStorage.setItem(MIGRATION_KEY, 'true'); } catch (_) {}
    }

    function currentPageTitle(code) {
        return cleanTitle(
            document.querySelector('meta[property="og:title"]')?.content
                || document.querySelector('h1')?.textContent
                || document.title,
            code
        );
    }

    function needsPersist(store, videos) {
        for (const entry of videos) {
            const code = entry[0];
            if (!VIDEO_CODE_RE.test(code)) continue;
            const existing = store.records[code];
            if (!existing) return true;
            const details = typeof entry[1] === 'string' ? { title: '' } : (entry[1] || {});
            if (!existing.title && cleanTitle(details.title, code)) return true;
        }
        return false;
    }

    function rememberVideos(videos) {
        writeQueue = writeQueue.catch(function () {}).then(async function () {
            // 先用内存缓存判断，绝大多数刷新不会触碰磁盘。
            const cached = await getStore(false);
            if (!needsPersist(cached, videos)) return;

            const store = await getStore(true);
            let changed = false;
            const now = Date.now();
            videos.forEach(function (value, code) {
                if (!VIDEO_CODE_RE.test(code)) return;
                const details = typeof value === 'string' ? { url: value, title: '' } : (value || {});
                const title = cleanTitle(details.title, code);
                const existing = store.records[code];
                if (existing) {
                    if (!existing.title && title) {
                        existing.title = title;
                        changed = true;
                    }
                    return;
                }
                store.records[code] = {
                    code,
                    url: details.url || `https://missav.ai/${code}`,
                    title: title || undefined,
                    t: now
                };
                changed = true;
            });
            if (!changed) return;
            await writeSharedStore(store);
            scheduleScan(true);
        });
        return writeQueue;
    }

    function linkCode(link) {
        const href = link.getAttribute('href');
        const cached = parsedLinks.get(link);
        if (cached && cached.href === href) return cached.code;
        const code = videoCodeFromUrl(href);
        parsedLinks.set(link, { href, code });
        return code;
    }

    function setLinkMark(link, currentCode) {
        if (!(link instanceof HTMLAnchorElement)) return;
        const code = linkCode(link);
        let state = '';
        if (code && code !== currentCode) {
            const isCover = link.parentElement?.matches('div.relative.aspect-w-16.aspect-h-9') === true;
            if (!isCover) {
                if (openCodes.has(code)) state = 'open';
                else if (historyCodes.has(code)) state = 'history';
            }
        }
        if (state === 'open') {
            if (link.getAttribute(MARK_ATTR) !== 'true') link.setAttribute(MARK_ATTR, 'true');
            if (link.hasAttribute(HISTORY_ATTR)) link.removeAttribute(HISTORY_ATTR);
        } else if (state === 'history') {
            if (link.hasAttribute(MARK_ATTR)) link.removeAttribute(MARK_ATTR);
            if (link.getAttribute(HISTORY_ATTR) !== 'true') link.setAttribute(HISTORY_ATTR, 'true');
        } else {
            if (link.hasAttribute(MARK_ATTR)) link.removeAttribute(MARK_ATTR);
            if (link.hasAttribute(HISTORY_ATTR)) link.removeAttribute(HISTORY_ATTR);
        }
    }

    function markTree(root, currentCode) {
        if (!(root instanceof Element)) return;
        if (root.tagName === 'A' && root.hasAttribute('href')) setLinkMark(root, currentCode);
        if (root.firstElementChild) {
            root.querySelectorAll('a[href]').forEach(function (link) {
                setLinkMark(link, currentCode);
            });
        }
    }

    function runScan() {
        scanFrame = 0;
        const roots = pendingRoots;
        const full = fullScanPending;
        pendingRoots = new Set();
        fullScanPending = false;

        const currentCode = videoCodeFromUrl(location.href);
        if (full || roots.size > FULL_SCAN_THRESHOLD) {
            document.querySelectorAll('a[href]').forEach(function (link) {
                setLinkMark(link, currentCode);
            });
            return;
        }
        roots.forEach(function (root) {
            if (root.isConnected) markTree(root, currentCode);
        });
    }

    function scheduleScan(full, root) {
        if (full) {
            fullScanPending = true;
        } else if (root instanceof Element) {
            if (pendingRoots.size <= FULL_SCAN_THRESHOLD) pendingRoots.add(root);
            else fullScanPending = true;
        }
        if (scanFrame) return;
        scanFrame = requestAnimationFrame(runScan);
    }

    async function readBackgroundVideoCodes() {
        if (typeof Scripting === 'undefined' || !Scripting.tabs?.query) return null;
        try {
            const tabs = await Scripting.tabs.query();
            const currentCode = videoCodeFromUrl(location.href);
            const seenVideos = new Map();
            const backgroundCodes = new Set();
            if (currentCode) seenVideos.set(currentCode, {
                url: location.href,
                title: currentPageTitle(currentCode)
            });
            tabs.forEach(function (tab) {
                const code = videoCodeFromUrl(tab.url);
                if (!code) return;
                seenVideos.set(code, { url: tab.url, title: tab.title });
                if (code !== currentCode && tab.active !== true) backgroundCodes.add(code);
            });
            void rememberVideos(seenVideos);
            return backgroundCodes;
        } catch (_) {
            return null;
        }
    }

    function sameCodes(a, b) {
        if (a.size !== b.size) return false;
        for (const code of a) {
            if (!b.has(code)) return false;
        }
        return true;
    }

    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        lastRefreshAt = Date.now();
        try {
            const codes = await readBackgroundVideoCodes();
            if (!codes || sameCodes(codes, openCodes)) return;
            openCodes = codes;
            scheduleScan(true);
        } finally {
            refreshing = false;
        }
    }

    function scheduleRefresh(delay) {
        const wait = Math.max(
            delay == null ? 0 : delay,
            REFRESH_INTERVAL - (Date.now() - lastRefreshAt)
        );
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
            refreshTimer = 0;
            void refresh();
        }, Math.max(0, wait));
    }

    function installStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
a[${MARK_ATTR}="true"]::before,
a[${HISTORY_ATTR}="true"]::before {
    display: inline-block;
    box-sizing: border-box;
    margin-inline-end: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    font: 600 10px/16px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    letter-spacing: 0;
    vertical-align: 2px;
    white-space: nowrap;
}
a[${MARK_ATTR}="true"]::before {
    content: "✓ 已打开";
    background: rgba(52, 199, 89, .16);
    color: rgb(48, 170, 78);
}
@media (prefers-color-scheme: dark) {
    a[${MARK_ATTR}="true"]::before {
        background: rgba(48, 209, 88, .18);
        color: rgb(105, 222, 126);
    }
}
a[${HISTORY_ATTR}="true"]::before {
    content: "✓ 曾打开";
    background: rgba(142, 142, 147, .16);
    color: rgb(99, 99, 102);
}
@media (prefers-color-scheme: dark) {
    a[${HISTORY_ATTR}="true"]::before {
        background: rgba(142, 142, 147, .20);
        color: rgb(174, 174, 178);
    }
}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function observePage() {
        const observer = new MutationObserver(function (mutations) {
            if (!openCodes.size && !historyCodes.size) return;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    if (mutation.target instanceof Element) scheduleScan(false, mutation.target);
                    continue;
                }
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) scheduleScan(false, node);
                }
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href']
        });
    }

    async function start() {
        if (!isMissAvHost(location.hostname)) return;
        installStyle();
        observePage();
        await loadHistory();
        const currentCode = videoCodeFromUrl(location.href);
        if (currentCode) {
            const currentTitle = currentPageTitle(currentCode);
            await rememberVideos(new Map([[
                currentCode,
                { url: location.href, title: currentTitle }
            ]]));
            if (!currentTitle && document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function () {
                    void rememberVideos(new Map([[
                        currentCode,
                        { url: location.href, title: currentPageTitle(currentCode) }
                    ]]));
                }, { once: true });
            }
        }
        scheduleScan(true);
        window.addEventListener('pageshow', function () { scheduleRefresh(0); });
        window.addEventListener('focus', function () { scheduleRefresh(0); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) scheduleRefresh(0);
        });
        void refresh();
    }

    void start();
})();
