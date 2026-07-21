// ==UserScript==
// @name         MissAV 批量取消收藏
// @namespace    https://missav.ai/
// @version      1.0.1
// @description  在收藏页一键取消所有收藏影片，自动翻页、实时进度、支持暂停。已测试，API 稳定可用。
// @author       Minis
// @match        https://missav.ai/saved*
// @match        https://missav.ai/*/saved*
// @match        https://missav.ws/saved*
// @match        https://missav.ws/*/saved*
// @match        https://missav.com/saved*
// @match        https://missav.com/*/saved*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── 可调参数 ──────────────────────────────────────────
  const DELAY_EACH  = 200;   // 每个影片取消收藏的间隔(ms)
  const DELAY_PAGE  = 400;   // 翻页之间的间隔(ms)
  const BATCH_SIZE  = 20;    // 每批多少个请求
  const BATCH_PAUSE = 1000;  // 每批结束后的额外暂停(ms)

  // ── 工具 ──────────────────────────────────────────────
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function fetchText(url, signal) {
    const response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.text();
  }

  function getXsrf() {
    const c = document.cookie.split(';').find(s => s.trim().startsWith('XSRF-TOKEN'));
    return c ? decodeURIComponent(c.split('=').slice(1).join('=')) : '';
  }

  async function unsave(origin, apiId, signal) {
    const r = await fetch(origin + '/api/items/' + apiId + '/save', {
      method: 'DELETE',
      credentials: 'include',
      signal,
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': getXsrf(),
      },
    });
    return r.status; // 204 = success, 404 = already removed
  }

  // 从影片页 HTML 提取 API item ID
  function extractApiId(html) {
    const m = html.match(/\/api\/items\/([a-z0-9]+)\/save/);
    return m ? m[1] : null;
  }

  // 从收藏页 HTML 提取影片链接（只取 grid 内含数字的番号链接）
  function extractVideoLinks(html, origin) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const links = [];
    const seen = new Set();

    // 只在影片 grid 内查找，避免导航栏干扰
    const grid = doc.querySelector('.grid.grid-cols-2') || doc.body;
    grid.querySelectorAll('a[href]').forEach(a => {
      try {
        const u = new URL(a.getAttribute('href'), origin);
        if (u.origin !== origin) return;
        const path = u.pathname.replace(/^\/|\/$/g, '');
        const last = path.split('/').pop();
        // 番号特征：最后一段同时含字母和数字（如 fc2-ppv-1067811、IPX-123）
        if (!last || !/[a-z]/i.test(last) || !/[0-9]/.test(last)) return;
        const full = origin + '/' + path;
        if (!seen.has(full)) { seen.add(full); links.push(full); }
      } catch (_) {}
    });
    return links;
  }

  // ── 解析总页数（精确匹配分页组件） ──────────────────
  function parseTotalPages(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 方案1：查找分页导航中的 "页数/总页数" 文本，如 "1 / 12"
    const paginationText = doc.querySelector('[x-text*="totalPages"], .pagination, nav[aria-label]');
    if (paginationText) {
      const m = paginationText.textContent.match(/\/\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    }

    // 方案2：查找最后一个分页链接的页码参数
    let maxPage = 1;
    doc.querySelectorAll('a[href*="?page="], a[href*="&page="]').forEach(a => {
      const m = a.href.match(/[?&]page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxPage) maxPage = n;
      }
    });
    if (maxPage > 1) return maxPage;

    // 方案3：查找 Alpine.js / Vue 数据中的 totalPages
    const scriptMatch = html.match(/['"](totalPages|total_pages)['"]\s*:\s*(\d+)/);
    if (scriptMatch) return parseInt(scriptMatch[2], 10);

    // 方案4：查找形如 "第 X / Y 页" 或 "Page X of Y" 的文本
    const pageOfMatch = html.match(/(?:第\s*\d+\s*\/\s*(\d+)\s*頁|[Pp]age\s+\d+\s+of\s+(\d+))/);
    if (pageOfMatch) return parseInt(pageOfMatch[1] || pageOfMatch[2], 10);

    return 1; // 默认只有1页
  }

  // ── UI ────────────────────────────────────────────────
  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'mu-panel';
    el.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:2147483647;
      background:#2e3440;color:#eceff4;border-radius:14px;padding:18px 20px;
      width:320px;box-shadow:0 8px 36px rgba(0,0,0,.55);
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;
      line-height:1.5;border:1px solid #4c566a;
    `;
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <b style="font-size:15px">🗑️ 批量取消收藏</b>
        <button id="mu-close" style="background:none;border:none;color:#81a1c1;cursor:pointer;font-size:20px;line-height:1;padding:0">×</button>
      </div>
      <div id="mu-status" style="color:#88c0d0;margin-bottom:10px;min-height:38px;word-break:break-all">
        点击「开始」将取消当前账号的全部收藏影片。
      </div>
      <div style="background:#3b4252;border-radius:6px;height:8px;margin-bottom:6px;overflow:hidden">
        <div id="mu-bar" style="background:#5e81ac;height:100%;width:0%;transition:width .25s"></div>
      </div>
      <div id="mu-counter" style="color:#d8dee9;font-size:12px;text-align:right;margin-bottom:14px">0 / 0</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button id="mu-start" style="flex:1;background:#bf616a;color:#fff;border:none;border-radius:8px;
          padding:9px 0;cursor:pointer;font-size:14px;font-weight:600">开始</button>
        <button id="mu-stop" disabled style="flex:1;background:#4c566a;color:#d8dee9;border:none;
          border-radius:8px;padding:9px 0;cursor:pointer;font-size:14px">暂停</button>
      </div>
      <div id="mu-log" style="max-height:110px;overflow-y:auto;font-size:11.5px;color:#7b8a9a;line-height:1.7"></div>
    `;
    document.body.appendChild(el);

    const status  = el.querySelector('#mu-status');
    const bar     = el.querySelector('#mu-bar');
    const counter = el.querySelector('#mu-counter');
    const log     = el.querySelector('#mu-log');
    const btnStart= el.querySelector('#mu-start');
    const btnStop = el.querySelector('#mu-stop');

    el.querySelector('#mu-close').onclick = () => el.remove();

    return {
      el, btnStart, btnStop,
      setStatus: t => { status.textContent = t; },
      setProgress: (cur, tot) => {
        const pct = tot ? Math.round(cur / tot * 100) : 0;
        bar.style.width = pct + '%';
        counter.textContent = `${cur} / ${tot}`;
      },
      log: (icon, msg) => {
        log.insertAdjacentHTML('afterbegin',
          `<div><span style="opacity:.7">${icon}</span> ${msg}</div>`);
      },
    };
  }

  // ── 主流程 ────────────────────────────────────────────
  async function runUnsaveAllLegacy(ui) {
    let stopped = false;
    ui.btnStart.disabled = true;
    ui.btnStop.disabled  = false;
    ui.btnStop.textContent = '暂停';
    ui.btnStop.onclick = () => {
      stopped = true;
      ui.btnStop.textContent = '停止中…';
    };

    const origin = location.origin;
    const savedPath = location.pathname.replace(/\/$/, '');

    // ① 收集所有影片链接（逐页扫描）
    // 第一页直接用当前页面 HTML，无需重复 fetch
    ui.setStatus('正在扫描收藏列表…');
    const page1Html = document.documentElement.outerHTML;
    const totalPages = parseTotalPages(page1Html);
    ui.log('📋', `共 ${totalPages} 页`);

    const allUrls = [];
    const globalSeen = new Set();
    const addLinks = links => {
      links.forEach(u => { if (!globalSeen.has(u)) { globalSeen.add(u); allUrls.push(u); }});
    };

    addLinks(extractVideoLinks(page1Html, origin));

    for (let p = 2; p <= totalPages; p++) {
      if (stopped) break;
      ui.setStatus(`扫描第 ${p} / ${totalPages} 页…`);
      const html = await (await fetch(origin + savedPath + '?page=' + p, {credentials:'include'})).text();
      addLinks(extractVideoLinks(html, origin));
      await sleep(DELAY_PAGE);
    }

    const total = allUrls.length;
    ui.log('🎬', `发现 ${total} 个收藏影片`);
    ui.setProgress(0, total);

    if (total === 0) {
      ui.setStatus('✅ 收藏列表为空，无需操作。');
      ui.btnStart.disabled = false;
      ui.btnStop.disabled = true;
      return;
    }

    // ② 逐一取消收藏
    let done = 0, failed = 0, noId = 0;

    for (let i = 0; i < allUrls.length; i++) {
      if (stopped) {
        ui.setStatus(`⏸ 已暂停（${done} 个已取消，剩余 ${total - i} 个）`);
        break;
      }

      const videoUrl = allUrls[i];
      const label = videoUrl.split('/').pop();
      ui.setStatus(`(${i + 1}/${total}) ${label}`);

      try {
        const html = await (await fetch(videoUrl, {credentials:'include'})).text();
        const apiId = extractApiId(html);

        if (!apiId) {
          noId++;
          ui.log('⚠️', `无 API ID：${label}`);
        } else {
          const status = await unsave(origin, apiId);
          if (status === 204 || status === 200 || status === 404) {
            done++;
            ui.log('✓', label);
          } else {
            failed++;
            ui.log('✗', `${label} (HTTP ${status})`);
          }
        }
      } catch (e) {
        failed++;
        ui.log('✗', `${label} (${e.message})`);
      }

      ui.setProgress(i + 1, total);

      // 速率控制
      if ((i + 1) % BATCH_SIZE === 0) {
        await sleep(BATCH_PAUSE);
      } else {
        await sleep(DELAY_EACH);
      }
    }

    if (!stopped) {
      ui.setStatus(`✅ 完成！取消 ${done}，失败 ${failed}，跳过 ${noId}`);
    }
    ui.btnStart.disabled = false;
    ui.btnStop.disabled = true;
  }

  // ── 注入悬浮按钮 ──────────────────────────────────────
  // 逐页扫描、逐页处理；AbortController 可中止当前请求和等待。
  async function runUnsaveAll(ui) {
    const controller = new AbortController();
    const { signal } = controller;
    let stopped = false;
    let discovered = 0;
    let processed = 0;
    let done = 0;
    let failed = 0;
    let noId = 0;
    let requestCount = 0;
    const seen = new Set();

    ui.btnStart.disabled = true;
    ui.btnStop.disabled = false;
    ui.btnStop.textContent = '暂停';
    ui.btnStop.onclick = () => {
      stopped = true;
      controller.abort();
      ui.btnStop.textContent = '停止中…';
    };

    const origin = location.origin;
    const savedPath = location.pathname.replace(/\/$/, '');

    try {
      ui.setStatus('正在扫描收藏列表…');
      const firstPage = document.documentElement.outerHTML;
      const totalPages = parseTotalPages(firstPage);
      ui.log('🔍', `共 ${totalPages} 页`);

      for (let page = 1; page <= totalPages && !stopped; page++) {
        ui.setStatus(`扫描第 ${page} / ${totalPages} 页…`);
        const html = page === 1
          ? firstPage
          : await fetchText(`${origin}${savedPath}?page=${page}`, signal);

        const urls = extractVideoLinks(html, origin)
          .filter(url => !seen.has(url));
        urls.forEach(url => seen.add(url));
        discovered += urls.length;

        for (const videoUrl of urls) {
          if (stopped) break;
          const label = videoUrl.split('/').pop();
          ui.setStatus(`已发现 ${discovered} 个，正在处理：${label}`);

          try {
            const videoHtml = await fetchText(videoUrl, signal);
            const apiId = extractApiId(videoHtml);

            if (!apiId) {
              noId++;
              ui.log('⚠️', `无 API ID：${label}`);
            } else {
              const status = await unsave(origin, apiId, signal);
              if (status === 204 || status === 200 || status === 404) {
                done++;
                ui.log('✅', label);
              } else {
                failed++;
                ui.log('❌', `${label} (HTTP ${status})`);
              }
            }
          } catch (error) {
            if (error.name === 'AbortError') break;
            failed++;
            ui.log('❌', `${label} (${error.message})`);
          }

          processed++;
          ui.setProgress(processed, discovered);
          requestCount++;
          await sleep(
            requestCount % BATCH_SIZE === 0 ? BATCH_PAUSE : DELAY_EACH,
            signal
          );
        }

        if (page < totalPages && !stopped) {
          await sleep(DELAY_PAGE, signal);
        }
      }

      if (stopped) {
        ui.setStatus(`⏹ 已停止（已处理 ${processed} 个，发现 ${discovered} 个）`);
      } else if (discovered === 0) {
        ui.setStatus('✅ 收藏列表为空，无需操作。');
      } else {
        ui.setStatus(`✅ 完成！取消 ${done}，失败 ${failed}，跳过 ${noId}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        ui.setStatus(`⏹ 已停止（已处理 ${processed} 个，发现 ${discovered} 个）`);
      } else {
        ui.setStatus(`执行失败：${error.message}`);
      }
    } finally {
      ui.btnStart.disabled = false;
      ui.btnStop.disabled = true;
    }
  }

  function inject() {
    if (document.getElementById('mu-fab') || document.getElementById('mu-panel')) return;

    const fab = document.createElement('button');
    fab.id = 'mu-fab';
    fab.textContent = '🗑️ 取消全部收藏';
    fab.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:2147483647;
      background:#bf616a;color:#fff;border:none;border-radius:50px;
      padding:11px 20px;font-size:14px;font-weight:700;cursor:pointer;
      box-shadow:0 4px 18px rgba(0,0,0,.45);
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      transition:background .15s,transform .15s;
    `;
    fab.onmouseenter = () => { fab.style.background='#d08770'; fab.style.transform='scale(1.04)'; };
    fab.onmouseleave = () => { fab.style.background='#bf616a'; fab.style.transform='scale(1)'; };
    fab.onclick = () => {
      fab.remove();
      const ui = buildPanel();
      ui.btnStart.onclick = () => runUnsaveAll(ui);
    };
    document.body.appendChild(fab);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
