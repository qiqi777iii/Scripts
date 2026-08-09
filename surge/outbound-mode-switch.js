/*
 * 出站模式切换
 * 网络变化时，通过 DIRECT 策略探测本机出口 IP 归属地：
 *   - 中国大陆 IP  -> 规则模式 (rule)
 *   - 非中国大陆 IP -> 直连模式 (direct)
 *
 * 设计要点：
 *   1. 去抖只对「同一个网络」生效。只要 SSID / IP / 网关发生变化，
 *      就立即重新探测，绝不因为“刚才刚查过”而漏切。
 *   2. 切网瞬间接口常未就绪，探测失败会按退避重试多次。
 *   3. 探测失败不写入状态，下一次事件不会被去抖拦住。
 *   4. 模式未变时不调用 setOutboundMode，避免 Surge 反复弹系统提示。
 *   5. 脚本自身不发通知（SILENT = true）。
 */

const NAME = '出站模式切换';
const STORE_KEY = 'outbound_mode_switch_state';
const TIMEOUT = 5; // 单次请求超时（秒）
const SAME_NET_DEBOUNCE = 15; // 同一网络内的去抖窗口（秒）
const RETRY_DELAYS = [0, 2, 4, 8]; // 探测重试间隔（秒）
const SILENT = true; // true = 脚本不发通知

const SOURCES = [
  {
    url: 'http://ip-api.com/json/?fields=status,countryCode,query',
    parse: (j) => (j.status === 'success' ? { cc: j.countryCode, ip: j.query } : null),
  },
  {
    url: 'https://api.ip.sb/geoip',
    parse: (j) => (j.country_code ? { cc: j.country_code, ip: j.ip } : null),
  },
  {
    url: 'https://ipinfo.io/json',
    parse: (j) => (j.country ? { cc: j.country, ip: j.ip } : null),
  },
];

function log(msg) {
  console.log('[' + NAME + '] ' + msg);
}

function notify(title, sub, body) {
  if (SILENT) return;
  $notification.post(title, sub, body);
}

function sleep(sec) {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

function readState() {
  try {
    return JSON.parse($persistentStore.read(STORE_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

// 网络身份：SSID + 本机 IP + 网关。任一变化都视为换了网络。
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

function request(url) {
  return new Promise((resolve) => {
    $httpClient.get(
      {
        url,
        timeout: TIMEOUT,
        headers: { 'User-Agent': 'Surge/Outbound-Mode-Switch', Accept: 'application/json' },
        opts: { policy: 'DIRECT' },
        node: 'DIRECT',
      },
      (err, resp, data) => {
        if (err || !resp || resp.status !== 200 || !data) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

async function detectOnce() {
  for (const s of SOURCES) {
    const json = await request(s.url);
    if (!json) continue;
    try {
      const r = s.parse(json);
      if (r && r.cc) return r;
    } catch (e) {
      /* 下一个源 */
    }
  }
  return null;
}

// 切网后接口需要时间就绪，失败则退避重试
async function detect() {
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    if (RETRY_DELAYS[i] > 0) await sleep(RETRY_DELAYS[i]);
    const r = await detectOnce();
    if (r) {
      if (i > 0) log('第 ' + (i + 1) + ' 次尝试探测成功');
      return r;
    }
    log('探测失败（第 ' + (i + 1) + ' 次）');
  }
  return null;
}

(async () => {
  const prev = readState();
  const key = netKey();
  const now = Date.now();

  // 去抖：仅当网络身份完全相同且刚刚成功检测过才跳过。
  // key 为空（拿不到网络信息）时不去抖，宁可多查一次。
  if (
    prev &&
    prev.ok &&
    key &&
    prev.key === key &&
    prev.ts &&
    now - prev.ts < SAME_NET_DEBOUNCE * 1000
  ) {
    log('网络未变且刚检测过，跳过');
    $done();
    return;
  }

  const info = await detect();

  if (!info) {
    // 不写入成功状态，下次事件必定重新探测
    $persistentStore.write(
      JSON.stringify({ ...(prev || {}), ok: false, ts: 0 }),
      STORE_KEY
    );
    log('所有重试均失败，出站模式保持不变');
    notify(NAME, '探测失败', '无法获取直连出口 IP 归属地，出站模式保持不变');
    $done();
    return;
  }

  const cc = String(info.cc).toUpperCase();
  const isCN = cc === 'CN';
  const mode = isCN ? 'rule' : 'direct';
  const modeText = isCN ? '规则模式' : '全局直连';
  const changed = !prev || !prev.ok || prev.mode !== mode;

  if (changed) {
    $surge.setOutboundMode(mode);
    log('已切换：' + modeText + '，IP=' + (info.ip || '未知') + '，归属地=' + cc);
    notify(
      NAME,
      `已切换：${modeText}`,
      `出口 IP：${info.ip || '未知'}\n归属地：${cc}${isCN ? '（中国大陆）' : '（境外）'}`
    );
  } else {
    log('保持：' + modeText + '，IP=' + (info.ip || '未知') + '，归属地=' + cc);
  }

  // 重新取一次网络身份：探测期间可能又切了网
  $persistentStore.write(
    JSON.stringify({ ok: true, key: netKey() || key, cc, ip: info.ip, mode, ts: Date.now() }),
    STORE_KEY
  );

  $done();
})();
