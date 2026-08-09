/*
 * 出站模式切换
 * 网络变化时，通过 DIRECT 策略探测本机出口 IP 归属地：
 *   - 中国大陆 IP  -> 规则模式 (rule)
 *   - 非中国大陆 IP -> 直连模式 (direct)
 *
 * 静默策略：
 *   1. 脚本自身不发通知（SILENT = true）。
 *   2. 模式与上次相同时不调用 setOutboundMode，避免 Surge 自身弹出
 *      「出站模式已更改」提示。
 *   3. 去抖：DEBOUNCE 秒内重复的 network-changed 只处理一次。
 */

const NAME = '出站模式切换';
const STORE_KEY = 'outbound_mode_switch_state';
const TIMEOUT = 5; // 探测超时（秒）
const DEBOUNCE = 10; // 去抖窗口（秒）
const SILENT = true; // true = 脚本不发通知

// 多个探测源，按顺序回退。全部使用 DIRECT 策略请求。
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

function readState() {
  try {
    return JSON.parse($persistentStore.read(STORE_KEY) || 'null');
  } catch (e) {
    return null;
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

async function detect() {
  for (const s of SOURCES) {
    const json = await request(s.url);
    if (!json) continue;
    try {
      const r = s.parse(json);
      if (r && r.cc) return r;
    } catch (e) {
      /* 继续下一个源 */
    }
  }
  return null;
}

(async () => {
  const prev = readState();
  const now = Date.now();

  // 去抖：短时间内的重复事件直接忽略
  if (prev && prev.ts && now - prev.ts < DEBOUNCE * 1000) {
    log('距上次检测不足 ' + DEBOUNCE + 's，跳过');
    $done();
    return;
  }

  const info = await detect();

  if (!info) {
    log('探测失败，出站模式保持不变');
    notify(NAME, '探测失败', '无法获取直连出口 IP 归属地，出站模式保持不变');
    $done();
    return;
  }

  const cc = String(info.cc).toUpperCase();
  const isCN = cc === 'CN';
  const mode = isCN ? 'rule' : 'direct';
  const modeText = isCN ? '规则模式' : '全局直连';
  const changed = !prev || prev.mode !== mode;

  // 只在模式真正变化时写入，避免 Surge 反复弹出系统提示
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

  $persistentStore.write(
    JSON.stringify({ cc, ip: info.ip, mode, ts: Date.now() }),
    STORE_KEY
  );

  $done();
})();
