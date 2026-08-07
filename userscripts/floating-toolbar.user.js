// ==UserScript==
// @name         悬浮工具栏
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.10.0
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
  // 旧实例的闭包可能已随页面重写失效；resume 抛错或未确认成功时必须继续完整启动，
  // 否则这次注入会直接 return，页面上再没有任何调度器，只能靠用户手动刷新。
  const previousInstance = document[INSTANCE_KEY];
  if (previousInstance?.resume) {
    let resumed = false;
    try { resumed = previousInstance.resume("reinjected") === true; } catch (_) { resumed = false; }
    if (!resumed) {
      try { document[INSTANCE_KEY] = null; } catch (_) {}
    }
    if (resumed) {
      return;
    }
  }
  const INSTANCE = { phase: "starting", resume: null };
  document[INSTANCE_KEY] = INSTANCE;

  // 保留旧 DOM ID，确保“新标签页打开”和 TabsSaver 的组合定位继续兼容。
  const TOOLBAR_ID = "universal-pagination-floating-menu";
  const STYLE_ID = `${TOOLBAR_ID}-style`;
  const GROUP_DRAG_EVENT = "floating-toolbar-group-drag";
  const BOUND_LINK_ID = "__tb__";
  const BOOKMARK_TOOLBAR_ID = "tab-save-toolbar";
  const PAGE_NAVIGATION_ID = "floating-page-navigation";
  const ITEM_SIZE = /(^|\.)nodeseek\.com$/i.test(location.hostname) ? 32 : 40;
  const CONNECT_OVERLAP = 1;
  const PAGE_NAVIGATION_RIGHT_GAP = 16;
  const SAFE_BOTTOM_GAP = 40;
  const DEFAULT_BOTTOM_GAP = 28;
  const DEFAULT_RIGHT_GAP = 60;

  const state = {
    presenceTimers: [],
    idleProbeInstalled: false,
    lastBroadcastVisible: null,
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
    retryTimer: null,
    refreshRetryCount: 0,
    listenersInstalled: false,
    pendingRefreshFlags: 0,
    refreshScheduled: false,
    refreshFrame: null,
    refreshFallbackTimer: null,
    refreshToken: 0,
    wakeRecoveryTimers: [],
  };

  const $ = (selector, root = document) => root.querySelector(selector);

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

  function elementWidth(id, fallback = 0) {
    const element = document.getElementById(id);
    if (!element?.isConnected) return fallback;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0) return rect.width;
    const computedWidth = Number.parseFloat(getComputedStyle(element).width);
    return Number.isFinite(computedWidth) && computedWidth > 0 ? computedWidth : fallback;
  }

  function rightAccessoryWidth() {
    // 优先读取相邻组件的实时宽度；组件暂未创建时才使用由当前按钮尺寸推导的兜底值。
    const navigation = document.getElementById(PAGE_NAVIGATION_ID);
    if (!navigation) return 0;
    return elementWidth(PAGE_NAVIGATION_ID, ITEM_SIZE * 2) + elementWidth("video-fullscreen", ITEM_SIZE);
  }

  function defaultRightGap() {
    return Math.max(DEFAULT_RIGHT_GAP, rightAccessoryWidth() + PAGE_NAVIGATION_RIGHT_GAP);
  }

  function clampPosition(left, top, toolbar) {
    const viewport = viewportBox();
    const width = Math.max(toolbar?.offsetWidth || 0, ITEM_SIZE * 2);
    const height = Math.max(toolbar?.offsetHeight || 0, ITEM_SIZE);
    const maxLeft = Math.max(0, viewport.width - width - rightAccessoryWidth());
    const boundControlWidth = elementWidth(BOUND_LINK_ID, ITEM_SIZE);
    const minLeft = document.getElementById(BOUND_LINK_ID) ? Math.min(boundControlWidth, maxLeft) : 0;
    return {
      left: Math.max(minLeft, Math.min(left, maxLeft)),
      top: Math.max(0, Math.min(top, viewport.height - height - SAFE_BOTTOM_GAP)),
    };
  }

  function controlsAreAdjacent(leftControl, rightControl) {
    if (!leftControl?.isConnected || !rightControl?.isConnected) return false;
    const leftRect = leftControl.getBoundingClientRect();
    const rightRect = rightControl.getBoundingClientRect();
    return leftRect.width > 0 && leftRect.height > 0 && rightRect.width > 0 && rightRect.height > 0 &&
      Math.abs(leftRect.right - rightRect.left) <= 1.5 && Math.abs(leftRect.top - rightRect.top) <= 1.5;
  }

  function refreshConnectedVisual(toolbar) {
    if (!toolbar?.isConnected) return;
    const linkToolbar = document.getElementById(BOUND_LINK_ID);
    const bookmarkToolbar = document.getElementById(BOOKMARK_TOOLBAR_ID);
    const connectedToLink = controlsAreAdjacent(linkToolbar, toolbar);
    const connectedToBookmark = !connectedToLink && controlsAreAdjacent(bookmarkToolbar, toolbar);
    const connected = connectedToLink || connectedToBookmark;
    toolbar.dataset.connectedLeft = connected ? "true" : "false";
    const pageNavigation = document.getElementById(PAGE_NAVIGATION_ID);
    const connectedRight = controlsAreAdjacent(toolbar, pageNavigation);
    toolbar.dataset.connectedRight = connectedRight ? "true" : "false";
    if (pageNavigation) {
      pageNavigation.dataset.connectedLeft = connectedRight ? "true" : "false";
    }
    const linkButton = document.getElementById("__tb_btn__");
    if (linkButton) linkButton.dataset.connectedRight = connectedToLink ? "true" : "false";
    const bookmarkButton = document.getElementById("tab-save-button");
    if (bookmarkButton && !linkToolbar) bookmarkButton.dataset.connectedRight = connectedToBookmark ? "true" : "false";
  }

  function positionBoundControl(toolbar) {
    if (!toolbar?.isConnected) return;
    const control = document.getElementById(BOUND_LINK_ID);
    if (!control) {
      refreshConnectedVisual(toolbar);
      return;
    }
    const rect = toolbar.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const controlWidth = control.getBoundingClientRect().width || control.offsetWidth || ITEM_SIZE;
    control.style.left = `${Math.max(0, rect.left - controlWidth + CONNECT_OVERLAP)}px`;
    control.style.right = "auto";
    const usesBottom = toolbar.style.bottom && toolbar.style.bottom !== "auto" && (!toolbar.style.top || toolbar.style.top === "auto");
    if (usesBottom) {
      control.style.bottom = toolbar.style.bottom;
      control.style.top = "auto";
    } else {
      control.style.top = `${rect.top}px`;
      control.style.bottom = "auto";
    }
    control.style.transform = "translate3d(0,0,0)";
    refreshConnectedVisual(toolbar);
  }

  function applyDefaultPosition(toolbar) {
    toolbar.style.right = `${defaultRightGap()}px`;
    toolbar.style.bottom = `${DEFAULT_BOTTOM_GAP}px`;
    toolbar.style.left = "auto";
    toolbar.style.top = "auto";
    positionBoundControl(toolbar);
  }

  function applySavedPosition(toolbar) {
    if (!state.savedPosition) return false;
    const position = clampPosition(state.savedPosition.left, state.savedPosition.top, toolbar);
    state.savedPosition = position;
    toolbar.style.left = `${position.left}px`;
    toolbar.style.top = `${position.top}px`;
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    positionBoundControl(toolbar);
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
      #${TOOLBAR_ID}[data-connected-left="true"] { border-radius: 0 999px 999px 0; box-shadow: inset -.5px 0 0 var(--qft-separator), inset 0 .5px 0 var(--qft-separator), inset 0 -.5px 0 var(--qft-separator); }
      #${TOOLBAR_ID}[data-connected-right="true"] { border-radius: 999px 0 0 999px; box-shadow: inset .5px 0 0 var(--qft-separator), inset 0 .5px 0 var(--qft-separator), inset 0 -.5px 0 var(--qft-separator); }
      #${TOOLBAR_ID}[data-connected-left="true"][data-connected-right="true"] { border-radius: 0; box-shadow: inset 0 .5px 0 var(--qft-separator), inset 0 -.5px 0 var(--qft-separator); }
      #${TOOLBAR_ID}[data-connected-left="true"]::before { content: ""; position: absolute; z-index: 2; left: 0; top: 7px; bottom: 7px; width: 1px; background: var(--qft-separator); pointer-events: none; }
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
      positionBoundControl(toolbar);
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
        positionBoundControl(toolbar);
      }
      requestRefresh(REFRESH_LAYOUT);
      setTimeout(() => { state.dragMoved = false; }, 0);
    };

    toolbar.addEventListener("pointerup", finish);
    toolbar.addEventListener("pointercancel", finish);
  }

  // 节点连着不等于看得见：站点 CSS 可能把它压成零尺寸或隐藏。
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

    toolbar.addEventListener(GROUP_DRAG_EVENT, (event) => {
      const left = Number(event.detail?.left);
      const top = Number(event.detail?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      const position = clampPosition(left, top, toolbar);
      toolbar.style.left = `${position.left}px`;
      toolbar.style.top = `${position.top}px`;
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
      state.savedPosition = position;
      const finished = event.detail?.phase === "end" || event.detail?.phase === "cancel";
      state.dragging = !finished;
      positionBoundControl(toolbar);
      if (finished) requestRefresh(REFRESH_LAYOUT);
    });

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
  const REFRESH_RETRY_DELAYS = [120, 300, 700, 1500, 3000, 6000];

  function scheduleRefreshRetry() {
    if (document.hidden || state.retryTimer || state.refreshRetryCount >= REFRESH_RETRY_DELAYS.length) return;
    const delay = REFRESH_RETRY_DELAYS[state.refreshRetryCount++];
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      requestRefresh(REFRESH_FULL);
    }, delay);
  }

  function cancelPendingRefreshSchedule() {
    state.refreshToken += 1;
    if (state.refreshFrame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.refreshFrame);
    if (state.refreshFallbackTimer != null) clearTimeout(state.refreshFallbackTimer);
    state.refreshFrame = null;
    state.refreshFallbackTimer = null;
    state.refreshScheduled = false;
  }

  function requestRefresh(flags = REFRESH_FULL) {
    state.pendingRefreshFlags |= flags;
    if ((document.hidden && INSTANCE.phase !== "starting") || state.refreshScheduled) return;
    state.refreshScheduled = true;
    const token = ++state.refreshToken;
    let completed = false;
    const run = () => {
      if (completed || token !== state.refreshToken) return;
      completed = true;
      if (state.refreshFrame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.refreshFrame);
      if (state.refreshFallbackTimer != null) clearTimeout(state.refreshFallbackTimer);
      state.refreshFrame = null;
      state.refreshFallbackTimer = null;
      state.refreshScheduled = false;
      const currentFlags = state.pendingRefreshFlags;
      state.pendingRefreshFlags = 0;
      const root = document.documentElement || document.body;
      if (!root) {
        state.pendingRefreshFlags |= REFRESH_FULL;
        scheduleRefreshRetry();
        return;
      }
      try {
        if (currentFlags & REFRESH_STRUCTURE) {
          installListenersOnce();
          ensureToolbar();
          ensureObserver();
        }
        if (currentFlags & REFRESH_LAYOUT) stabilizePosition();
        state.initialized = true;
        INSTANCE.phase = "running";
        broadcastAccessoryState();
        state.refreshRetryCount = 0;
        if (state.retryTimer) {
          clearTimeout(state.retryTimer);
          state.retryTimer = null;
        }
      } catch (error) {
        INSTANCE.phase = "failed";
        state.pendingRefreshFlags |= REFRESH_FULL;
        log("刷新恢复中", error);
        scheduleRefreshRetry();
      }
    };
    if (typeof requestAnimationFrame === "function") {
      state.refreshFrame = requestAnimationFrame(run);
      state.refreshFallbackTimer = setTimeout(run, 240);
    } else {
      state.refreshFallbackTimer = setTimeout(run, 16);
    }
  }

  const ACCESSORIES_CHANGE_EVENT = "floating-accessories-change";
  // 有界存在性校验：健康即提前停止，全程不使用常驻轮询。
  // 各脚本只分叉这一组参数，校验逻辑本身保持五份同构。
  // 固定显示工具栏只需覆盖初始建栏和页面早期重写窗口；后续由 DOM 守卫和生命周期事件恢复。
  const PRESENCE_PROFILE = {
    delays: [0, 200, 700],
    probeEvents: ["pointerdown"],
  };

  function cancelPresenceChecks() {
    state.presenceTimers.forEach(clearTimeout);
    state.presenceTimers = [];
  }

  function schedulePresenceChecks() {
    cancelPresenceChecks();
    PRESENCE_PROFILE.delays.forEach((delay) => {
      state.presenceTimers.push(setTimeout(() => {
        if (document.hidden) return;
        if (toolbarPresent()) {
          cancelPresenceChecks();
          return;
        }
        requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
      }, delay));
    });
  }

  // 用户真正看到页面的那一刻必查一次；once 监听，几乎无开销。
  function installIdleProbeOnce() {
    if (state.idleProbeInstalled) return;
    state.idleProbeInstalled = true;
    const probe = () => {
      if (!document.hidden && !toolbarPresent()) requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
    };
    const options = { once: true, passive: true, capture: true };
    PRESENCE_PROFILE.probeEvents.forEach((type) => window.addEventListener(type, probe, options));
  }

  // 邻居靠这个广播重算拼接圆角，去重避免无信息重发。
  function broadcastAccessoryState() {
    const visible = toolbarPresent();
    if (state.lastBroadcastVisible === visible) return;
    state.lastBroadcastVisible = visible;
    try {
      window.dispatchEvent(new CustomEvent(ACCESSORIES_CHANGE_EVENT, { detail: { id: TOOLBAR_ID, visible } }));
    } catch (_) {}
  }

  function recoverRefresh() {
    state.navigating = false;
    state.refreshRetryCount = 0;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    cancelPendingRefreshSchedule();
    requestRefresh(REFRESH_FULL);
  }

  // iOS 从后台恢复时，网站可能在唤醒事件之后才重建 DOM；用有限恢复脉冲覆盖该窗口。
  function scheduleWakeRecovery() {
    state.wakeRecoveryTimers.forEach(clearTimeout);
    state.wakeRecoveryTimers = [];
    const run = () => {
      if (!document.hidden) recoverRefresh();
    };
    run();
    [120, 450, 1200].forEach((delay) => state.wakeRecoveryTimers.push(setTimeout(run, delay)));
  }

  function installListenersOnce() {
    if (state.listenersInstalled) return;
    state.listenersInstalled = true;
    window.addEventListener(ACCESSORIES_CHANGE_EVENT, (event) => {
      if (event?.detail?.id === TOOLBAR_ID) return; // 自己发的不用再听，防循环
      requestRefresh(REFRESH_LAYOUT);
    });
    window.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.visualViewport?.addEventListener("resize", () => requestRefresh(REFRESH_LAYOUT));
    window.addEventListener("pageshow", scheduleWakeRecovery);
    window.addEventListener("focus", scheduleWakeRecovery);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleWakeRecovery();
    });
  }

  function ensureObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      const toolbarMissing = !toolbarHealthy(document.getElementById(TOOLBAR_ID));
      const styleMissing = document.getElementById(STYLE_ID) !== state.styleElement || !state.styleElement?.isConnected;
      const boundControlChanged = mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node instanceof Element && ([BOUND_LINK_ID, BOOKMARK_TOOLBAR_ID, PAGE_NAVIGATION_ID].includes(node.id) || node.querySelector?.(`#${BOUND_LINK_ID}, #${BOOKMARK_TOOLBAR_ID}, #${PAGE_NAVIGATION_ID}`))));
      if (toolbarMissing || styleMissing) requestRefresh(REFRESH_STRUCTURE | REFRESH_LAYOUT);
      else if (boundControlChanged) requestRefresh(REFRESH_LAYOUT);
    });
    state.observer.observe(document, { subtree: true, childList: true });
  }

  // resume 必须同步把结构建好并返回真实结果；
  // 如果只排个异步刷新就 return true，新旧实例会同时重建节点互相抢。
  function resume() {
    try {
      cancelPendingRefreshSchedule();
      state.refreshRetryCount = 0;
      ensureToolbar();
      ensureObserver();
      installListenersOnce();
      requestRefresh(REFRESH_LAYOUT);
      schedulePresenceChecks();
      installIdleProbeOnce();
    } catch (_) {
      return false;
    }
    return toolbarPresent();
  }

  function init() {
    requestRefresh(REFRESH_FULL);
    schedulePresenceChecks();
    installIdleProbeOnce();
  }

  INSTANCE.resume = resume;
  installListenersOnce();
  init();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", recoverRefresh, { once: true });
  }
  if (document.readyState !== "complete") window.addEventListener("load", recoverRefresh, { once: true });
})();
