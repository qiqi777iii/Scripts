/*
 * 出站模式切换
 * 网络变化时，通过 DIRECT 策略探测本机出口 IP 归属地：
 *   - 中国大陆 IP  -> 规则模式 (rule)
 *   - 非中国大陆 IP -> 直连模式 (direct)
 * 仅在 event: network-changed 时触发，不做轮询。
 */

const NAME = '出站模式切换';
const STORE_KEY = 'outbound_mode_switch_state';
const TIMEOUT = 5; // 秒
const SILENT = false; // true = 不发通知

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

function notify(title, sub, body) {
  if (SILENT) return;
  $notification.post(title, sub, body);
}

(async () => {
  const info = await detect();

  if (!info) {
    notify(NAME, '探测失败', '无法获取直连出口 IP 归属地，出站模式保持不变');
    $done();
    return;
  }

  const cc = String(info.cc).toUpperCase();
  const isCN = cc === 'CN';
  const mode = isCN ? 'rule' : 'direct';

  let prev = null;
  try {
    prev = JSON.parse($persistentStore.read(STORE_KEY) || 'null');
  } catch (e) {
    prev = null;
  }

  $surge.setOutboundMode(mode);

  $persistentStore.write(
    JSON.stringify({ cc, ip: info.ip, mode, ts: Date.now() }),
    STORE_KEY
  );

  const changed = !prev || prev.mode !== mode;
  const modeText = isCN ? '规则模式' : '全局直连';
  notify(
    NAME,
    changed ? `已切换：${modeText}` : `保持：${modeText}`,
    `出口 IP：${info.ip || '未知'}\n归属地：${cc}${isCN ? '（中国大陆）' : '（境外）'}`
  );

  $done();
})();
