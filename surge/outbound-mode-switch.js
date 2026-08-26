/*
 * 出站模式切换 v2.1
 *
 * 通过 DIRECT 策略探测本机出口 IP 归属地：
 *   中国大陆 IP  -> 规则模式 (rule)
 *   非中国大陆 IP -> 直连模式 (direct)
 *
 * v2.0 修复 / 改进：
 *   1. [致命] 修正 $httpClient 参数：Surge 只认顶层 policy 字段，
 *      旧版写的 opts:{policy}/node 完全无效，探测请求实际走的是规则匹配，
 *      在规则模式下会拿到代理出口 IP，导致误判并卡在直连模式。
 *   2. [致命] 不再依赖 $persistentStore 里缓存的 mode 判断“是否需要切换”，
 *      改为用 $httpAPI GET /v1/outbound 读取 Surge 真实当前模式。
 *      旧版一旦缓存与实际不符（手动改过模式 / setOutboundMode 失败 /
 *      重启后回到配置默认值），就会认为“已经是规则模式了”而永不下发切换，
 *      表现就是卡在直连模式回不去。
 *   3. 切换后回读校验，未生效则用 HTTP API 再下发一次。
 *   4. 探测源并发竞速 + 总时间预算，避免串行重试超过脚本 timeout 被杀，
 *      导致既没切换也没写状态。
 *   5. 探测彻底失败时执行 fail-safe：若当前是直连模式，回落到规则模式，
 *      而不是原地保持直连（规则模式在境内境外都不会断网）。
 *   6. 无 countryCode 的源可回落 $utils.geoip 本地库判定。
 *   7. 增加 engine-started / profile-reloaded / cron 自愈入口，
 *      网络事件丢失或探测失败后能自动纠正。
 *
 * v2.1 改进：
 *   通知分级 —— notify=1 时事件触发的切换会发通知，但每 30 分钟的
 *   cron 兜底自愈强制静默（只写 Logbook），避免后台校正反复打扰。
 *
 * v2.2 改进：
 *   全部参数通过模块参数表暴露，可在 Surge 界面直接编辑，无需改脚本。
 *   参数带合法性校验，填错会回落安全默认值而不是让脚本误判。
 *
 * v2.3 改进：
 *   [重要] 全局代理保护。旧版只认 rule/direct 两态，用户手动开启的
 *   全局代理会在下一次网络变化时被脚本静默覆盖掉。现在默认尊重手动
 *   意图：检测到当前是全局代理就不接管，直到用户自己切回 rule/direct。
 *
 * 可选 argument（由模块参数表自动传入，也可手写）：
 *   notify=0        全部静默
 *   notify=1        事件切换发通知，cron 定时兜底静默 ← 推荐
 *   notify=2        全部发通知（含 cron 兜底）
 *   failsafe=rule   探测失败时的兜底模式：rule / keep（默认 rule）
 *   cn=CN,HK        视为“走规则模式”的国家码列表（默认 CN）
 *   debounce=15     同一网络的去抖窗口秒数（默认 15，上限 300）
 *   selfheal=true   是否启用启动/重载/定时自愈（默认 true）
 *   global=respect  全局代理策略：respect 永不接管（默认）/
 *                   hold60 保持 60 分钟后恢复接管 / takeover 无视全局代理
 */

const NAME = '出站模式切换 v2.3';
const STORE_KEY = 'outbound_mode_switch_state';

const ARG = (() => {
  const o = {};
  try {
    if (typeof $argument === 'string' && $argument) {
      $argument.split('&').forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });
    }
  } catch (e) {}
  return o;
})();

const FAILSAFE = (ARG.failsafe || 'rule').toLowerCase() === 'keep' ? 'keep' : 'rule';
const CN_CODES = (() => {
  const list = (ARG.cn || 'CN')
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  return list.length ? list : ['CN']; // 参数填错时回落默认，避免所有 IP 都被判为境外
})();
const SELFHEAL = String(ARG.selfheal || 'true').toLowerCase() !== 'false';

// 全局代理模式的处理策略（关键：尊重用户手动意图）
//   respect  检测到当前是全局代理时完全不接管，保持不动（默认）
//   hold=N   保持 N 分钟后恢复自动接管；N 分钟内的网络变化不会覆盖
//   takeover 无视全局代理，照常自动切换（旧版行为）
const GLOBAL_POLICY = (() => {
  const v = String(ARG.global || 'respect').toLowerCase().trim();
  if (v === 'takeover') return { kind: 'takeover', minutes: 0 };
  const m = /^hold[:=]?(\d+)$/.exec(v);
  if (m) {
    const n = Math.max(1, Math.min(parseInt(m[1], 10), 1440)); // 1 分钟 - 24 小时
    return { kind: 'hold', minutes: n };
  }
  return { kind: 'respect', minutes: 0 };
})();

const REQ_TIMEOUT = 4;            // 单次请求超时（秒）
const TOTAL_BUDGET = 20;          // 整个探测阶段的时间预算（秒），必须小于脚本 timeout
const RETRY_DELAYS = [0, 2, 5];   // 轮次间隔（秒），切网瞬间接口未就绪时退避

// 去抖窗口：模块参数可调，限制在 0-300 秒
const SAME_NET_DEBOUNCE = (() => {
  const n = parseInt(ARG.debounce, 10);
  return isNaN(n) || n < 0 ? 15 : Math.min(n, 300);
})();

const IS_CRON = (() => {
  try {
    return typeof $script !== 'undefined' && $script.type === 'cron';
  } catch (e) {
    return false;
  }
})();

// 是否为自愈类触发（启动 / 配置重载 / 定时兜底）
const IS_SELFHEAL_RUN = (() => {
  if (IS_CRON) return true;
  try {
    return typeof $event !== 'undefined' && $event &&
      ($event.name === 'engine-started' || $event.name === 'profile-reloaded');
  } catch (e) {
    return false;
  }
})();

// 通知开关：
//   notify=0  全部静默
//   notify=1  事件切换发通知，cron 定时兜底静默（推荐，不被后台校正打扰）
//   notify=2  全部发通知（含 cron 兜底）
const NOTIFY_LEVEL = (() => {
  const v = String(ARG.notify || '0').toLowerCase();
  if (v === 'true' || v === 'yes') return 1;
  if (v === 'false' || v === 'no') return 0;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : Math.max(0, Math.min(n, 2));
})();
const NOTIFY = IS_CRON ? NOTIFY_LEVEL >= 2 : NOTIFY_LEVEL >= 1;

const SOURCES = [
  {
    url: 'http://ip-api.com/json/?fields=status,countryCode,query',
    parse: (t) => {
      const j = JSON.parse(t);
      return j.status === 'success' ? { cc: j.countryCode, ip: j.query } : null;
    },
  },
  {
    url: 'https://api.ip.sb/geoip',
    parse: (t) => {
      const j = JSON.parse(t);
      return j.ip ? { cc: j.country_code, ip: j.ip } : null;
    },
  },
  {
    url: 'https://ipinfo.io/json',
    parse: (t) => {
      const j = JSON.parse(t);
      return j.ip ? { cc: j.country, ip: j.ip } : null;
    },
  },
  {
    // 纯文本，最轻量，作为兜底
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    parse: (t) => {
      const ip = /(?:^|\n)ip=([^\n]+)/.exec(t);
      const loc = /(?:^|\n)loc=([^\n]+)/.exec(t);
      return ip ? { cc: loc ? loc[1] : '', ip: ip[1] } : null;
    },
  },
];

const deadline = Date.now() + TOTAL_BUDGET * 1000;
const left = () => deadline - Date.now();

function log(m) {
  console.log('[' + NAME + '] ' + m);
}

function book(m) {
  try {
    $surge.logbook(m);
  } catch (e) {}
}

function notify(title, sub, body) {
  if (!NOTIFY) return;
  try {
    $notification.post(title, sub, body, { 'auto-dismiss': true, sound: false });
  } catch (e) {
    try {
      $notification.post(title, sub, body);
    } catch (e2) {}
  }
}

function sleep(sec) {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

/* ---------- Surge 真实状态读写 ---------- */

// script 模式名 -> HTTP API 模式名
const API_MODE = { direct: 'direct', rule: 'rule', 'global-proxy': 'proxy' };

function httpAPI(method, path, body) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    setTimeout(() => fin(null), 3000);
    try {
      $httpAPI(method, path, body || {}, (res) => fin(res || null));
    } catch (e) {
      fin(null);
    }
  });
}

// 返回 'direct' | 'rule' | 'global-proxy' | null
async function getCurrentMode() {
  const r = await httpAPI('GET', '/v1/outbound', null);
  if (!r || !r.mode) return null;
  if (r.mode === 'proxy') return 'global-proxy';
  return r.mode;
}

async function applyMode(mode) {
  let ok = false;
  try {
    ok = $surge.setOutboundMode(mode) !== false;
  } catch (e) {
    ok = false;
  }
  // 回读校验：setOutboundMode 返回 true 也不代表一定生效
  const now = await getCurrentMode();
  if (now === mode) return true;
  if (now === null) return ok; // 拿不到真实状态，只能信返回值

  log('回读发现未生效（当前=' + now + '），改用 HTTP API 重试');
  await httpAPI('POST', '/v1/outbound', { mode: API_MODE[mode] || mode });
  const again = await getCurrentMode();
  return again === mode || again === null;
}

/* ---------- 状态 ---------- */

function readState() {
  try {
    return JSON.parse($persistentStore.read(STORE_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

function writeState(s) {
  try {
    $persistentStore.write(JSON.stringify(s), STORE_KEY);
  } catch (e) {}
}

// 网络身份：SSID + 本机 IP + 网关，任一变化即视为换网
function netKey() {
  try {
    const n = typeof $network !== 'undefined' ? $network : null;
    if (!n) return '';
    const ssid = (n.wifi && n.wifi.ssid) || '';
    const v4 = n.v4 || {};
    return [ssid, v4.primaryAddress || '', v4.primaryRouter || ''].join('|');
  } catch (e) {
    return '';
  }
}

/* ---------- 探测 ---------- */

function request(url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    setTimeout(() => fin(null), (REQ_TIMEOUT + 1) * 1000);
    try {
      $httpClient.get(
        {
          url,
          timeout: REQ_TIMEOUT,
          policy: 'DIRECT', // 关键：Surge 只认这个字段
          'auto-redirect': true,
          headers: { 'User-Agent': 'Surge Outbound-Mode-Switch/2.0', Accept: '*/*' },
        },
        (err, resp, data) => {
          if (err || !resp || resp.status !== 200 || !data) return fin(null);
          fin(String(data));
        }
      );
    } catch (e) {
      fin(null);
    }
  });
}

function normalize(r) {
  if (!r || !r.ip) return null;
  let cc = (r.cc || '').toUpperCase().trim();
  if (!cc || cc.length !== 2) {
    try {
      cc = String($utils.geoip(r.ip) || '').toUpperCase();
    } catch (e) {
      cc = '';
    }
  }
  return cc && cc.length === 2 ? { cc, ip: r.ip } : null;
}

// 所有源并发竞速，先返回有效结果者胜出
function detectOnce() {
  return new Promise((resolve) => {
    let settled = false;
    let pending = SOURCES.length;
    const fin = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    SOURCES.forEach((s) => {
      request(s.url).then((text) => {
        let r = null;
        if (text) {
          try {
            r = normalize(s.parse(text));
          } catch (e) {
            r = null;
          }
        }
        if (r) return fin(r);
        if (--pending === 0) fin(null);
      });
    });
  });
}

async function detect() {
  const rounds = IS_CRON ? 1 : RETRY_DELAYS.length; // cron 自愈只探一轮，省电
  for (let i = 0; i < rounds; i++) {
    if (RETRY_DELAYS[i] > 0) {
      if (left() < (RETRY_DELAYS[i] + REQ_TIMEOUT + 1) * 1000) break;
      await sleep(RETRY_DELAYS[i]);
    }
    if (left() < (REQ_TIMEOUT + 1) * 1000) break;
    const r = await detectOnce();
    if (r) {
      if (i > 0) log('第 ' + (i + 1) + ' 轮探测成功');
      return r;
    }
    log('探测失败（第 ' + (i + 1) + ' 轮）');
  }
  return null;
}

/* ---------- 主流程 ---------- */

(async () => {
  // selfheal=false 时，自愈类触发（启动/重载/定时兜底）直接退出，
  // 只保留网络变化这一个入口。
  if (IS_SELFHEAL_RUN && !SELFHEAL) {
    log('自愈已在模块参数中关闭，跳过本次触发');
    $done();
    return;
  }

  const prev = readState();
  const key = netKey();
  const now = Date.now();
  const current = await getCurrentMode(); // Surge 的真实模式

  // ── 全局代理保护 ──────────────────────────────────────────
  // 用户手动开启全局代理是明确意图，脚本不应擅自覆盖。
  // 只有当上一次是脚本自己写入的模式时，才说明这不是手动操作。
  if (current === 'global-proxy') {
    if (GLOBAL_POLICY.kind === 'respect') {
      log('当前为全局代理（手动设置），不接管');
      writeState({ ...(prev || {}), globalSince: prev && prev.globalSince ? prev.globalSince : now });
      $done();
      return;
    }
    if (GLOBAL_POLICY.kind === 'hold') {
      // 记录进入全局代理的时间，保持窗口内不接管
      const since = prev && prev.globalSince ? prev.globalSince : now;
      const elapsed = now - since;
      const holdMs = GLOBAL_POLICY.minutes * 60 * 1000;
      if (elapsed < holdMs) {
        const restMin = Math.ceil((holdMs - elapsed) / 60000);
        log('当前为全局代理，保持期剩余约 ' + restMin + ' 分钟，不接管');
        writeState({ ...(prev || {}), globalSince: since });
        $done();
        return;
      }
      log('全局代理保持期已满（' + GLOBAL_POLICY.minutes + ' 分钟），恢复自动接管');
      book('全局代理保持期已满，恢复自动切换');
    }
    // takeover：直接往下走，照常接管
  } else if (prev && prev.globalSince) {
    // 已离开全局代理，清除计时
    writeState({ ...prev, globalSince: 0 });
  }

  // 去抖：网络未变 + 刚成功探测过 + 真实模式与预期一致，才跳过。
  // 只要真实模式和上次结论不符（被手动改过 / 切换失败 / 重启回默认），一律重新判定。
  // 当前处于 direct 时永不去抖：直连是风险态（判错会大面积断网），宁可多探一次。
  if (
    !IS_SELFHEAL_RUN &&
    current !== 'direct' &&
    SAME_NET_DEBOUNCE > 0 &&
    prev &&
    prev.ok &&
    key &&
    prev.key === key &&
    prev.ts &&
    now - prev.ts < SAME_NET_DEBOUNCE * 1000 &&
    (current === null || current === prev.mode)
  ) {
    log('网络未变、刚检测过且模式一致，跳过');
    $done();
    return;
  }

  const info = await detect();

  if (!info) {
    // 兜底：卡在直连是最糟的情况（境内会大面积无法访问），回落规则模式
    if (FAILSAFE === 'rule' && current === 'direct') {
      const ok = await applyMode('rule');
      log('探测失败，fail-safe 回落规则模式：' + (ok ? '成功' : '失败'));
      book('探测失败，已回落规则模式');
      notify(NAME, '探测失败', '无法确认出口归属地，已回落为规则模式');
      writeState({ ok: false, key, mode: 'rule', ts: 0, failsafe: true });
    } else {
      log('探测失败，保持当前模式：' + (current || '未知'));
      writeState({ ...(prev || {}), ok: false, ts: 0 });
    }
    $done();
    return;
  }

  const cc = info.cc;
  const isCN = CN_CODES.indexOf(cc) >= 0;
  const mode = isCN ? 'rule' : 'direct';
  const modeText = isCN ? '规则模式' : '全局直连';

  // 只要真实模式不等于目标模式就下发；真实模式读不到时退回比较缓存
  const need = current !== null ? current !== mode : !prev || !prev.ok || prev.mode !== mode;

  let applied = true;
  if (need) {
    applied = await applyMode(mode);
    log(
      (applied ? '已切换：' : '切换失败：') +
        modeText +
        '，IP=' + info.ip + '，归属地=' + cc +
        '，原模式=' + (current || '未知')
    );
    book('切换为' + modeText + '（' + cc + ' / ' + info.ip + '）');
    notify(
      NAME,
      '已切换：' + modeText,
      '出口 IP：' + info.ip + '\n归属地：' + cc + (isCN ? '（中国大陆）' : '（境外）')
    );
  } else {
    log('保持：' + modeText + '，IP=' + info.ip + '，归属地=' + cc);
  }

  writeState({
    ok: applied,
    key: netKey() || key, // 探测期间可能又切了网，重取一次
    cc,
    ip: info.ip,
    mode,
    ts: Date.now(),
    globalSince: 0, // 已由脚本接管，清除全局代理计时
  });

  $done();
})().catch((e) => {
  log('异常：' + e);
  $done();
});
