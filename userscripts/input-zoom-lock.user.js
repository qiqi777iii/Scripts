// ==UserScript==
// @name         输入框缩放锁定
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/input-zoom-lock.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/input-zoom-lock.user.js
// @description  聚焦输入框时临时锁定页面缩放，避免 Safari 自动放大，失焦后恢复原状。
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_KEY = '__inputZoomLockV1__';
    if (document[INSTANCE_KEY]) return;
    document[INSTANCE_KEY] = true;

    // iPadOS 桌面模式下 UA 伪装成 Mac，用触点数补判。
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;

    // 会唤起键盘并触发自动放大的输入类型；其余（checkbox/radio/range/按钮等）一律不处理。
    const KEYBOARD_INPUT_TYPES = new Set([
        'text', 'search', 'email', 'url', 'tel', 'password', 'number',
        'date', 'datetime-local', 'month', 'time', 'week', ''
    ]);

    // 锁定态用的 content：保留原有宽度/初始缩放语义，额外禁止缩放。
    const LOCKED_CONTENT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
    // 还原时先写一帧带 initial-scale 的值，强制 Safari 重新计算缩放，再写回原值。
    const RESET_CONTENT = 'width=device-width, initial-scale=1, maximum-scale=10, user-scalable=yes';

    let meta = null;
    let metaCreated = false;
    let originalContent = null;   // 仅在首次锁定时记录，避免连续切换输入框时被污染
    let locked = false;
    let restoreTimer = 0;

    function ensureMeta() {
        if (meta && meta.isConnected) return meta;
        meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
            const head = document.head || document.documentElement;
            if (!head) return null;
            meta = document.createElement('meta');
            meta.setAttribute('name', 'viewport');
            meta.setAttribute('content', 'width=device-width, initial-scale=1');
            head.appendChild(meta);
            metaCreated = true;
        }
        return meta;
    }

    function shouldLock(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag !== 'INPUT') return false;
        if (el.readOnly || el.disabled) return false;
        return KEYBOARD_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
    }

    function lockZoom() {
        if (restoreTimer) {
            clearTimeout(restoreTimer);
            restoreTimer = 0;
        }
        if (locked) return;
        const m = ensureMeta();
        if (!m) return;
        // 只在真正由未锁定进入锁定时快照原值，防止把锁定值当成原值存下来。
        originalContent = metaCreated ? null : m.getAttribute('content');
        m.setAttribute('content', LOCKED_CONTENT);
        locked = true;
    }

    function unlockZoom() {
        if (!locked) return;
        const m = ensureMeta();
        if (!m) { locked = false; return; }
        // 先写 reset 再写回原值，两次不同的 content 才能让 Safari 把已放大的视口缩回去。
        m.setAttribute('content', RESET_CONTENT);
        const restoreTo = originalContent;
        requestAnimationFrame(() => {
            if (locked) return; // 期间又聚焦了别的输入框，交给新的锁定流程
            if (restoreTo != null) {
                m.setAttribute('content', restoreTo);
            } else {
                m.setAttribute('content', 'width=device-width, initial-scale=1');
            }
        });
        locked = false;
        originalContent = null;
    }

    // focus/blur 不冒泡，必须用捕获阶段；在 document 上一次绑定即可覆盖动态插入的元素。
    document.addEventListener('focus', (e) => {
        if (shouldLock(e.target)) lockZoom();
    }, true);

    document.addEventListener('blur', () => {
        // 延后一帧再解锁：blur→focus 连续切换输入框时不做无谓的锁/解锁抖动。
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
            restoreTimer = 0;
            const active = document.activeElement;
            if (shouldLock(active)) return;
            unlockZoom();
        }, 100);
    }, true);

    // 页面隐藏/卸载时兜底还原，避免把锁定态留给 bfcache 恢复后的页面。
    window.addEventListener('pagehide', () => {
        if (restoreTimer) {
            clearTimeout(restoreTimer);
            restoreTimer = 0;
        }
        unlockZoom();
    });
})();
