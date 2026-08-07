// ==UserScript==
// @name         悬浮工具栏
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.10.2
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/floating-toolbar.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/floating-toolbar.user.js
// @description  提供关闭当前标签页、新建 Safari 起始页及可拖动的悬浮工具栏。
// @author       Scripting Agent
// @match        http://*/*
// @match        https://*/*
// @run-at       document-end
// @grant        GM.log
// @grant        GM.closeTab
// @grant        GM.openInTab
// @grant        Scripting.tabs
// ==/UserScript==

(() => {
  "use strict";

  const INSTANCE_KEY = "__floatingToolbarInstanceV1__";
  const previousInstance = document[INSTANCE_KEY];
  if (previousInstance?.resume) {
    let resumed = false;
    try { resumed = previousInstance.resume("reinjected") === true; } catch (_) { resumed = false; }
    if (!resumed) {
      try { document[INSTANCE_KEY] = null; } catch (_) {}
    }
    if (resumed) return;
  }
  const INSTANCE = { phase: "starting", resume: null };
  document[INSTANCE_KEY] = INSTANCE;

  const TOOLBAR_ID = "universal-pagination-floating-menu";
  const STYLE_ID = `${TOOLBAR_ID}-style`;
  const ITEM_SIZE = /(^|\.)nodeseek\.com$/i.test(location.hostname) ? 32 : 40;
  const SAFE_BOTTOM_GAP = 40;
  const DEFAULT_BOTTOM_GAP = 40;
  const DEFAULT_RIGHT_GAP = 80;

  const state = {
    initialized: false,
    navigating: false,
    dragging: false,
    dragMoved: false,
    suppressClickUntil: 0,
    savedPosition: null,
    observer: null,
    toolbar: null,
    styleElement: null,
    newTabButton: null,
    closeTabButton: null,
    listenersInstalled: false,
    pendingRefreshFlags: 0,
    refreshScheduled: false,
  };

  function log(...args) {
    try {
      if (typeof GM !== "undefined" && GM.log) GM.log("[悬浮工具栏]", ...args);
      else console.log("[悬浮工具栏]", ...args);
    } catch (_) {}
  }

  function absorbEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function isolateToolbar(root) {
    ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "mousedown", "mouseup", "click"].forEach((type) => {
      root.addEventListener(type, absorbEvent, { passive: false });
    });
  }

  function viewportBox() {
    const viewport = window.visualViewport;
    const layoutWidth = document.documentElement.clientWidth || innerWidth || 0;
    const layoutHeight = document.documentElement.clientHeight || innerHeight || 0;
    return {
      width: Math.max(1, Math.floor(viewport?.width || 0), Math.floor(layoutWidth), Math.floor(innerWidth || 0)),
      height: Math.max(1, Math.floor(viewport?.height || 0), Math.floor(layoutHeight), Math.floor(innerHeight || 0)),
    };
  }

  function clampPosition(left, top, toolbar) {
    const viewport = viewportBox();
    const width = Math.max(toolbar?.offsetWidth || 0, ITEM_SIZE * 2);
    const height = Math.max(toolbar?.offsetHeight || 0, ITEM_SIZE);
    const maxLeft = Math.max(0, viewport.width - width);
    return {
      left: Math.max(0, Math.min(left, maxLeft)),
      top: Math.max(0, Math.min(top, viewport.height - height - SAFE_BOTTOM_GAP)),
    };
  }

  function applyDefaultPosition(toolbar) {
    toolbar.style.right = `${DEFAULT_RIGHT_GAP}px`;
    toolbar.style.bottom = `${DEFAULT_BOTTOM_GAP}px`;
    toolbar.style.left = "auto";
    toolbar.style.top = "auto";
  }

  function applySavedPosition(toolbar) {
    if (!state.savedPosition) return false;
    const position = clampPosition(state.savedPosition.left, state.savedPosition.top, toolbar);
    state.savedPosition = position;
    toolbar.style.left = `${position.left}px`;
    toolbar.style.top = `${position.top}px`;
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    return true;
  }

  function addStyles() {
    const existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle === state.styleElement && state.styleElement?.isConnected) return;
    existingStyle?.remove?.();
    if (state.styleElement && state.styleElement !== existingStyle) state.styleElement.remove?.();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLBAR_ID} {
        --qft-text: rgba(28,28,30,.82);
        --qft-bg: #F2F2F7;
        --qft-separator: rgba(60,60,67,.16);
        box-sizing: border-box;
        position: fixed;
        right: ${DEFAULT_RIGHT_GAP}px;
        bottom: ${DEFAULT_BOTTOM_GAP}px;
        z-index: 2147483647;
        width: ${ITEM_SIZE * 2}px;
        height: ${ITEM_SIZE}px;
        display: flex;
        align-items: center;
        color: var(--qft-text);
        background: var(--qft-bg);
        border: 0;
        border-radius: 999px;
        box-shadow: inset 0 0 0 .5px var(--qft-separator);
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }
      @media (prefers-color-scheme: dark) {
        #${TOOLBAR_ID} {
          --qft-text: rgba(255,255,255,.94);
          --qft-bg: #2C2C2E;
          --qft-separator: rgba(255,255,255,.16);
        }
      }
      #${TOOLBAR_ID} button {
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
      #${TOOLBAR_ID} button + button::before {
        content: "";
        position: absolute;
        left: 0;
        top: 7px;
        bottom: 7px;
        width: 1px;
        background: var(--qft-separator);
        pointer-events: none;
      }
      #${TOOLBAR_ID} button svg {
        width: 20px;
        height: 20px;
        display: block;
        pointer-events: none;
      }
      #${TOOLBAR_ID} .new-tab svg {
        stroke: currentColor;
        stroke-width: 2.4;
        stroke-linecap: round;
        fill: none;
      }
      #${TOOLBAR_ID} .close-tab { color: #ff3b30; }
      @media (prefers-color-scheme: dark) {
        #${TOOLBAR_ID} .close-tab { color: #ff453a; }
      }
    `;
    state.styleElement = style;
    document.documentElement.appendChild(style);
  }

  async function closeCurrentTab() {
    if (state.navigating) return;
    state.navigating = true;
    try {
      const current = await Scripting.tabs.getCurrent();
      if (!Number.isInteger(current?.id)) throw new Error("无法获取当前标签页 ID");
      await GM.closeTab(current.id);
    } catch (error) {
      state.navigating = false;
      log("关闭当前标签页失败", error);
    }
  }

  async function openStartPage() {
    try {
      await GM.openInTab(undefined, { active: true });
    } catch (error) {
      log("新建 Safari 起始页失败", error);
    }
  }

  function bindAction(button, action) {
    let lastRun = 0;
    const run = (event) => {
      if (state.dragMoved || Date.now() < state.suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      const now = Date.now();
      if (now - lastRun < 450) return;
      lastRun = now;
      void action();
    };
    button.addEventListener("pointerup", run, { passive: false });
    button.addEventListener("touchend", run, { passive: false });
    button.addEventListener("click", run, { passive: false });
  }

  function setupDrag(toolbar) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const move = (clientX, clientY) => {
      const position = clampPosition(startLeft + clientX - startX, startTop + clientY - startY, toolbar);
      toolbar.style.left = `${position.left}px`;
      toolbar.style.top = `${position.top}px`;
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
    };

    toolbar.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      pointerId = event.pointerId;
      state.dragMoved = false;
      startX = event.clientX;
      startY = event.clientY;
      const rect = toolbar.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
    });

    toolbar.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!state.dragMoved && Math.abs(dx) <= 6 && Math.abs(dy) <= 6) return;
      event.preventDefault();
      event.stopPropagation();
      if (!state.dragMoved) {
        state.dragMoved = true;
        state.dragging = true;
        try { toolbar.setPointerCapture(pointerId); } catch (_) {}
      }
      move(event.clientX, event.clientY);
    });

    const finish = (event) => {
      if (pointerId !== event.pointerId) return;
      const moved = state.dragMoved;
      try { toolbar.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      state.dragging = false;
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        const rect = toolbar.getBoundingClientRect();
        state.savedPosition = clampPosition(rect.left, rect.top, toolbar);
        state.suppressClickUntil = Date.now() + 500;
      }
      requestRefresh(REFRESH_LAYOUT);
      setTimeout(() => { state.dragMoved = false; }, 0);
    };

    toolbar.addEventListener("pointerup", finish);
    toolbar.addEventListener("pointercancel", finish);
  }

  function elementVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function toolbarPresent() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    return toolbarHealthy(toolbar) && elementVisible(toolbar);
  }

  function toolbarHealthy(toolbar) {
    return Boolean(
      toolbar &&
      toolbar === state.toolbar &&
      toolbar.isConnected &&
      toolbar.ownerDocument === document &&
      toolbar.querySelector(".new-tab") === state.newTabButton &&
      toolbar.querySelector(".close-tab") === state.closeTabButton
    );
  }

  function createToolbar() {
    addStyles();
    const existing = document.getElementById(TOOLBAR_ID);
    if (toolbarHealthy(existing)) return existing;
    existing?.remove();
    if (state.toolbar && state.toolbar !== existing) state.toolbar.remove?.();

    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "悬浮工具栏");
    toolbar.innerHTML = `
      <button class="new-tab" type="button" title="新建 Safari 起始页" aria-label="新建 Safari 起始页">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"></path></svg>
      </button>
      <button class="close-tab" type="button" title="关闭当前标签页" aria-label="关闭当前标签页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </button>
    `;
    isolateToolbar(toolbar);
    document.documentElement.appendChild(toolbar);
    const newTabButton = toolbar.querySelector(".new-tab");
    const closeTabButton = toolbar.querySelector(".close-tab");
    bindAction(newTabButton, openStartPage);
    bindAction(closeTabButton, closeCurrentTab);
    state.newTabButton = newTabButton;
    state.closeTabButton = closeTabButton;
    setupDrag(toolbar);

    state.toolbar = toolbar;
    if (!applySavedPosition(toolbar)) applyDefaultPosition(toolbar);
    return toolbar;
  }

  function stabilizePosition() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar || state.dragging) return;
    if (!applySavedPosition(toolbar)) applyDefaultPosition(toolbar);
  }

  function ensureToolbar() {
    const toolbar = createToolbar();
    state.toolbar = toolbar;
    return toolbar;
  }

  const REFRESH_STRUCTURE = 1;
  const REFRESH_LAYOUT = 2;
  const REFRESH_FULL = REFRESH_STRUCTURE | REFRESH_LAYOUT;

  function requestRefresh(flags = REFRESH_FULL) {
    state.pendingRefreshFlags |= flags;
    if ((document.hidden && INSTANCE.phase !== "starting") || state.refreshScheduled) return;
    state.refreshScheduled = true;
    queueMicrotask(() => {
      state.refreshScheduled = false;
      const currentFlags = state.pendingRefreshFlags;
      state.pendingRefreshFlags = 0;
      if (!document.documentElement) return;
      try {
        if (currentFlags & REFRESH_STRUCTURE) {
          installListenersOnce();
          ensureToolbar();
          ensureObserver();
        }
        if (currentFlags & REFRESH_LAYOUT) stabilizePosition();
        state.initialized = true;
        INSTANCE.phase = "running";
      } catch (error) {
        INSTANCE.phase = "failed";
        log("刷新失败，等待下一次页面事件恢复", error);
      }
    });
  }

  function recoverRefresh() {
    if (document.hidden) return;
    state.navigating = false;
    state.pendingRefreshFlags = 0;
    state.refreshScheduled = false;
    requestRefresh(REFRESH_FULL);
  }

  function installListenersOnce() {
    if (state.listenersInstalled) return;
    state.listenersInstalled = true;
    window.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.visualViewport?.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.addEventListener("pageshow", recoverRefresh);
    window.addEventListener("focus", recoverRefresh);
    document.addEventListener("visibilitychange", recoverRefresh);
  }

  function ensureObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      const toolbarMissing = !toolbarHealthy(document.getElementById(TOOLBAR_ID));
      const styleMissing = document.getElementById(STYLE_ID) !== state.styleElement || !state.styleElement?.isConnected;
      if (toolbarMissing || styleMissing) requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
    });
    state.observer.observe(document.documentElement, { childList: true });
  }

  function resume() {
    try {
      state.pendingRefreshFlags = 0;
      state.refreshScheduled = false;
      ensureToolbar();
      ensureObserver();
      installListenersOnce();
      requestRefresh(REFRESH_LAYOUT);
    } catch (_) {
      return false;
    }
    return toolbarPresent();
  }

  function init() {
    try {
      ensureToolbar();
      ensureObserver();
      installListenersOnce();
      requestRefresh(REFRESH_LAYOUT);
    } catch (error) {
      INSTANCE.phase = "failed";
      log("初始化失败，等待下一次页面事件恢复", error);
    }
  }

  INSTANCE.resume = resume;
  installListenersOnce();
  init();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", recoverRefresh, { once: true });
  }
  if (document.readyState !== "complete") window.addEventListener("load", recoverRefresh, { once: true });
})();
