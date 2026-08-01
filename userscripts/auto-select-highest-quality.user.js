// ==UserScript==
// @name         视频自动最高质量
// @namespace    https://github.com/qiqi777iii/Scripts
// @version      1.0.5
// @description  自动将视频播放器切换并锁定为可用的最高画质
// @updateURL    https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/auto-select-highest-quality.user.js
// @downloadURL  https://raw.githubusercontent.com/qiqi777iii/Scripts/main/userscripts/auto-select-highest-quality.user.js
// @match        https://eporner.com/video-*
// @match        https://*.eporner.com/video-*
// @match        https://eporner.com/embed/*
// @match        https://*.eporner.com/embed/*
// @match        https://xhamster.com/videos/*
// @match        https://*.xhamster.com/videos/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict"

  const IS_XHAMSTER =
    location.hostname === "xhamster.com" || location.hostname.endsWith(".xhamster.com")

  if (IS_XHAMSTER) {
    const QUALITY_ITEM = "#quality-modal .xplayer-settings-menu-new__option.quality[value]"
    const PLAYER_ROOT = "#video_box, [data-role='xplayer']"
    const VIDEO_SELECTOR = "#xplayer__video"
    const USER_PLAYBACK_ATTRIBUTE = "data-user-playback-until"
    const RETRY_INTERVAL = 500
    const MAX_RETRIES = 40

    let scheduled = false
    let retryTimer = 0
    let retries = 0
    let bootstrapObserver = null
    let playerObserver = null
    let qualityObserver = null
    let observedPlayer = null
    let observedQualityMenu = null
    let lastLog = ""

    const getQuality = item => {
      const value = item.getAttribute("value") || ""
      const match = value.match(/^(\d{3,4})\s*p$/i)
      return match ? Number(match[1]) : 0
    }

    const userPlaybackRequested = video => {
      const videoUntil = Number(video?.getAttribute(USER_PLAYBACK_ATTRIBUTE) || 0)
      const pageUntil = Number(document.documentElement?.getAttribute(USER_PLAYBACK_ATTRIBUTE) || 0)
      return Math.max(videoUntil, pageUntil) > Date.now()
    }

    const clickWithoutAutoplay = item => {
      const video = document.querySelector(VIDEO_SELECTOR)
      const keepPaused = Boolean(video?.paused)

      const preventUnexpectedPlay = event => {
        const target = event.target
        if (
          target instanceof HTMLVideoElement &&
          target.matches(VIDEO_SELECTOR) &&
          !userPlaybackRequested(target)
        ) {
          target.pause()
        }
      }

      if (keepPaused) document.addEventListener("play", preventUnexpectedPlay, true)
      item.click()

      if (!keepPaused) return
      queueMicrotask(() => {
        const currentVideo = document.querySelector(VIDEO_SELECTOR)
        if (currentVideo && !userPlaybackRequested(currentVideo)) currentVideo.pause()
      })
      setTimeout(() => document.removeEventListener("play", preventUnexpectedPlay, true), 1500)
    }

    const observeTargets = (playerRoot, qualityMenu) => {
      if (playerRoot && observedPlayer !== playerRoot) {
        playerObserver?.disconnect()
        playerObserver = new MutationObserver(() => scheduleApply())
        playerObserver.observe(playerRoot, { childList: true, subtree: true })
        observedPlayer = playerRoot
      }

      if (qualityMenu && observedQualityMenu !== qualityMenu) {
        qualityObserver?.disconnect()
        qualityObserver = new MutationObserver(() => scheduleApply())
        qualityObserver.observe(qualityMenu, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "aria-disabled", "value"]
        })
        observedQualityMenu = qualityMenu
      }
    }

    const applyHighestQuality = () => {
      scheduled = false
      const playerRoot = document.querySelector(PLAYER_ROOT)
      const qualityMenu = document.querySelector("#quality-modal")
      const choices = Array.from(document.querySelectorAll(QUALITY_ITEM))
        .filter(item => item.getAttribute("aria-disabled") !== "true")
        .map(item => ({ item, quality: getQuality(item) }))
        .filter(({ quality }) => quality > 0)
        .sort((left, right) => right.quality - left.quality)

      observeTargets(playerRoot, qualityMenu)
      const highest = choices[0]
      if (!playerRoot || !highest) return false

      if (!highest.item.classList.contains("selected")) {
        clickWithoutAutoplay(highest.item)
        const message = `已选择 ${highest.quality}p`
        if (message !== lastLog) {
          console.info(`[视频自动最高质量] ${message}`)
          lastLog = message
        }
      }
      return true
    }

    function scheduleApply() {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(applyHighestQuality)
    }

    const stopBootstrap = () => {
      bootstrapObserver?.disconnect()
      bootstrapObserver = null
      clearInterval(retryTimer)
      retryTimer = 0
    }

    const start = () => {
      stopBootstrap()
      retries = 0
      lastLog = ""

      if (document.documentElement) {
        bootstrapObserver = new MutationObserver(scheduleApply)
        bootstrapObserver.observe(document.documentElement, { childList: true, subtree: true })
      }

      scheduleApply()
      retryTimer = setInterval(() => {
        retries += 1
        if (applyHighestQuality() || retries >= MAX_RETRIES) stopBootstrap()
      }, RETRY_INTERVAL)
    }

    const handleNavigation = () => queueMicrotask(start)
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method]
      history[method] = function (...args) {
        const result = original.apply(this, args)
        handleNavigation()
        return result
      }
    }

    document.addEventListener("DOMContentLoaded", start, { once: true })
    document.addEventListener("loadedmetadata", scheduleApply, true)
    document.addEventListener("loadstart", scheduleApply, true)
    addEventListener("popstate", handleNavigation)
    addEventListener("pageshow", start)

    if (document.documentElement) start()
    return
  }

  const PLAYER_ID = "EPvideo"
  const MAX_STARTUP_ATTEMPTS = 50
  const STARTUP_RETRY_DELAY = 300
  const ENSURE_DELAY = 250

  let player = null
  let observer = null
  let startupTimer = 0
  let startupAttempts = 0
  let ensureTimer = 0
  let contentStarted = false
  let switching = false

  const isUsablePlayer = candidate => {
    if (!candidate) return false
    try {
      return typeof candidate.isDisposed !== "function" || !candidate.isDisposed()
    } catch {
      return false
    }
  }

  const getPlayer = () => {
    if (typeof window.videojs !== "function") return null
    try {
      const existing = window.videojs.getPlayer?.(PLAYER_ID)
      return isUsablePlayer(existing) ? existing : null
    } catch {
      return null
    }
  }

  const getSettings = currentPlayer => {
    try {
      return currentPlayer.EPvideo?.getSettings?.() || null
    } catch {
      return null
    }
  }

  const getResolution = source => {
    const values = [source?.height, source?.labelShort, source?.label]
    for (const value of values) {
      const match = String(value ?? "").match(/(\d{3,4})\s*p?/i)
      if (match) return Number(match[1])
    }
    return 0
  }

  const getHighestSource = currentPlayer => {
    const settings = getSettings(currentPlayer)
    const sources = Array.isArray(settings?.sources) ? settings.sources : []
    let best = null

    sources.forEach((source, index) => {
      if (!source || String(source.labelShort).toLowerCase() === "auto") return
      const height = getResolution(source)
      if (!height) return
      if (!best || height > best.height) best = { index, height, source, settings }
    })

    return best
  }

  const isPlayingAd = currentPlayer => {
    try {
      return Boolean(currentPlayer.EPvideo?.isInVast?.())
    } catch {
      return true
    }
  }

  const selectInSettings = target => {
    const sources = target.settings.sources
    target.settings.selectedQuality = target.index
    sources.forEach((source, index) => {
      if (source) source.selected = index === target.index
    })
  }

  const prepareHighestPreference = () => {
    if (!isUsablePlayer(player)) return null
    const target = getHighestSource(player)
    if (!target) return null
    selectInSettings(target)
    return target
  }

  const sameMediaSource = (left, right) => {
    if (!left || !right) return false
    try {
      const leftUrl = new URL(left, location.href)
      const rightUrl = new URL(right, location.href)
      return leftUrl.href === rightUrl.href
    } catch {
      return left === right
    }
  }

  const getCurrentSource = currentPlayer => {
    try {
      return currentPlayer.currentSrc?.() || currentPlayer.src?.() || ""
    } catch {
      return ""
    }
  }

  const updateQualityDisplay = target => {
    selectInSettings(target)
    try {
      if (typeof player.EPqualityPicker?.switchQualityMenu === "function") {
        player.EPqualityPicker.switchQualityMenu(target.index, "video")
      } else {
        player.EPvideo?.updateQualityInfo?.()
      }
    } catch {}
  }

  const ensureHighestQuality = () => {
    ensureTimer = 0
    if (!isUsablePlayer(player) || !contentStarted || isPlayingAd(player)) return

    const target = prepareHighestPreference()
    if (!target) return

    const currentSource = getCurrentSource(player)
    if (sameMediaSource(currentSource, target.source.src)) {
      switching = false
      updateQualityDisplay(target)
      return
    }

    if (switching) return
    switching = true

    try {
      if (typeof player.switchQuality === "function") {
        player.switchQuality(target.index, "video")
      } else if (typeof player.EPvideo?.switchQuality === "function") {
        player.EPvideo.switchQuality(target.index, "video", true)
      } else {
        switching = false
        return
      }
      console.info(`[视频自动最高质量] 已选择 ${target.height}p`)
    } catch (error) {
      switching = false
      console.warn("[视频自动最高质量] 切换画质失败", error)
    }
  }

  const scheduleEnsure = (delay = ENSURE_DELAY) => {
    if (ensureTimer) clearTimeout(ensureTimer)
    ensureTimer = setTimeout(ensureHighestQuality, delay)
  }

  const markContentStarted = () => {
    if (!isUsablePlayer(player) || isPlayingAd(player)) return
    contentStarted = true
    prepareHighestPreference()
    scheduleEnsure()
  }

  const handleQualityData = () => {
    prepareHighestPreference()
    if (contentStarted) scheduleEnsure()
  }

  const handleSourceReady = () => {
    if (isPlayingAd(player)) return
    switching = false
    if (contentStarted) scheduleEnsure(100)
  }

  const bindPlayer = currentPlayer => {
    if (!isUsablePlayer(currentPlayer)) return false
    if (player === currentPlayer) {
      prepareHighestPreference()
      return true
    }

    player = currentPlayer
    prepareHighestPreference()

    player.on?.("loadedqualitydata", handleQualityData)
    player.on?.("videoFirstPlay", markContentStarted)
    player.on?.("vast.videoFirstPlayAfterVAST", markContentStarted)
    player.on?.("vast.contentStart", markContentStarted)
    player.on?.("playing", markContentStarted)
    player.on?.("loadeddata", handleSourceReady)
    player.on?.("sourceset", handleSourceReady)
    player.on?.("resolutionchange", handleSourceReady)
    player.ready?.(prepareHighestPreference)
    return true
  }

  const scheduleStart = (delay = STARTUP_RETRY_DELAY) => {
    if (startupTimer || startupAttempts >= MAX_STARTUP_ATTEMPTS) return
    startupTimer = setTimeout(() => {
      startupTimer = 0
      const currentPlayer = getPlayer()
      if (currentPlayer) {
        bindPlayer(currentPlayer)
        observer?.disconnect()
        observer = null
        return
      }
      startupAttempts += 1
      scheduleStart()
    }, delay)
  }

  const start = () => {
    if (document.documentElement && !observer) {
      observer = new MutationObserver(() => {
        if (document.getElementById(PLAYER_ID) || window.videojs) scheduleStart(0)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    scheduleStart(0)
  }

  if (document.documentElement) start()
  else addEventListener("DOMContentLoaded", start, { once: true })
  addEventListener("load", () => scheduleStart(0), { once: true })
})()
