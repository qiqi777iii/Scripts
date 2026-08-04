// ==UserScript==
// @name Ohentai 弹窗广告拦截
// @namespace https://github.com/qiqi777iii/Scripts
// @version 1.0.0
// @description 拦截页面点击触发的弹窗广告与跳转，移除第三方广告脚本和广告 iframe
// @updateURL https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/ohentai-popup-blocker.user.js
// @downloadURL https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/ohentai-popup-blocker.user.js
// @match https://ohentai.org/*
// @match https://www.ohentai.org/*
// @run-at document-start
// @inject-into page
// @grant none
// ==/UserScript==

(() => {
  "use strict"

  // 站点正常运行所需的外部脚本域名白名单（后缀匹配）
  const ALLOWED_HOSTS = [
    "ohentai.org",
    "jwpcdn.com",
    "googletagmanager.com",
    "google-analytics.com",
    "disqus.com",
    "disquscdn.com"
  ]

  const hostAllowed = (url) => {
    try {
      const host = new URL(url, location.href).hostname
      return ALLOWED_HOSTS.some(h => host === h || host.endsWith("." + h))
    } catch {
      return true
    }
  }

  // 1) 拦截 window.open：弹窗广告的核心手段，站内无正常 window.open 需求
  const fakeWindow = () => {
    const stub = {
      closed: true,
      close() {},
      focus() {},
      blur() {},
      postMessage() {},
      document: { write() {}, close() {} },
      location: { href: "", replace() {}, assign() {} }
    }
    return stub
  }
  const blockOpen = () => fakeWindow()
  try {
    Object.defineProperty(window, "open", {
      value: blockOpen,
      writable: false,
      configurable: false
    })
  } catch {
    window.open = blockOpen
  }

  // 2) 拦截脚本伪造的 a.click()（popunder 常用：创建 target=_blank 链接后程序化点击）
  const nativeAnchorClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (!this.isConnected || !hostAllowed(this.href)) return
    return nativeAnchorClick.call(this)
  }

  // 3) 拦截非用户真实触发的顶层跳转点击（capture 阶段最先处理）
  const guardClick = (e) => {
    if (e.isTrusted) return
    const a = e.target && e.target.closest && e.target.closest("a[href]")
    if (a && !hostAllowed(a.href)) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }
  window.addEventListener("click", guardClick, true)

  // 4) 在广告脚本执行前移除：非白名单外部 <script> 与广告 iframe
  const shouldRemove = (node) => {
    if (node.tagName === "SCRIPT" && node.src) return !hostAllowed(node.src)
    if (node.tagName === "IFRAME" && node.src) return !hostAllowed(node.src)
    return false
  }
  const sweep = (root) => {
    if (root.nodeType !== 1) return
    if (shouldRemove(root)) {
      if (root.tagName === "SCRIPT") {
        // 阻止已入队的脚本执行
        root.type = "javascript/blocked"
        root.removeAttribute("src")
      }
      root.remove()
      return
    }
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll("script[src], iframe[src]")) {
        if (shouldRemove(el)) {
          if (el.tagName === "SCRIPT") {
            el.type = "javascript/blocked"
            el.removeAttribute("src")
          }
          el.remove()
        }
      }
    }
  }
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) sweep(node)
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  // 5) 页面加载完成后停止大范围监听，只保留已生效的拦截（低开销）
  window.addEventListener("load", () => {
    setTimeout(() => observer.disconnect(), 3000)
  }, { once: true })
})()
