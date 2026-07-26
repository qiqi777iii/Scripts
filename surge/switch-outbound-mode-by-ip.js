/*
 * Surge 网络变化出口模式切换
 * 仅通过 IPPure 官方 API 检查 DIRECT 出口：CN -> rule，非 CN -> direct。
 * 检测期间和检测失败时使用 rule，避免旧的 direct 模式导致网站无法访问。
 */

var CONFIG = {
  endpoint: "https://my.ippure.com/v1/info",
  settleDelayMs: 1200,
  requestTimeoutSeconds: 8,
  maxAttempts: 3,
  retryDelayMs: 1800,
  watchdogMs: 38000,
  executionKey: "switch-outbound-mode-by-ip:execution",
};

var executionToken = Date.now() + ":" + Math.random();
var finished = false;
var finalizing = false;
var baselineChanged = false;
var lastFailure = "";
var watchdog = null;

try {
  $persistentStore.write(executionToken, CONFIG.executionKey);
} catch (_) {}

function isLatestExecution() {
  try {
    return $persistentStore.read(CONFIG.executionKey) === executionToken;
  } catch (_) {
    return true;
  }
}

function finish() {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  $done();
}

function stopIfStale() {
  if (finished) return true;
  if (isLatestExecution()) return false;
  console.log("[IPPure 出口模式] 检测到更新的网络变化任务，当前任务停止");
  finish();
  return true;
}

function normalizeCountry(value) {
  var country = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : "";
}

function isPublicIPv4(ip) {
  var parts = ip.split(".");
  if (parts.length !== 4) return false;

  var numbers = [];
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    var value = Number(parts[i]);
    if (value < 0 || value > 255) return false;
    numbers.push(value);
  }

  var a = numbers[0];
  var b = numbers[1];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isPublicIPv6(ip) {
  var value = ip.toLowerCase();
  if (value.indexOf(":") < 0 || !/^[0-9a-f:]+$/.test(value)) return false;
  if (value === "::" || value === "::1") return false;
  if (/^(fc|fd)/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) {
    return false;
  }
  return true;
}

function isPublicIP(ip) {
  return isPublicIPv4(ip) || isPublicIPv6(ip);
}

function parseIPPure(data) {
  var info = JSON.parse(data);
  return {
    ip: typeof info.ip === "string" ? info.ip.trim() : "",
    country: normalizeCountry(info.countryCode),
  };
}

function recordFailure(attempt, reason) {
  lastFailure = reason;
  console.log(
    "[IPPure 出口模式] 第 " +
      attempt +
      "/" +
      CONFIG.maxAttempts +
      " 次检测失败：" +
      reason
  );
}

function requestIPPure(attempt) {
  if (stopIfStale()) return;

  var separator = CONFIG.endpoint.indexOf("?") >= 0 ? "&" : "?";
  var url = CONFIG.endpoint + separator + "_=" + Date.now();

  $httpClient.get(
    {
      url: url,
      policy: "DIRECT",
      timeout: CONFIG.requestTimeoutSeconds,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      },
    },
    function (error, response, data) {
      if (stopIfStale() || finalizing) return;

      var status = response && Number(response.status);
      if (error || !status || status < 200 || status >= 300) {
        retryOrUseSafeRule(attempt, error || "HTTP " + (status || "无响应"));
        return;
      }

      var result;
      try {
        result = parseIPPure(data);
      } catch (_) {
        retryOrUseSafeRule(attempt, "响应格式无效");
        return;
      }

      if (!isPublicIP(result.ip)) {
        retryOrUseSafeRule(attempt, "未返回有效公网 IP");
        return;
      }
      if (!result.country) {
        retryOrUseSafeRule(attempt, "响应缺少有效 countryCode");
        return;
      }

      console.log(
        "[IPPure 出口模式] " + result.ip + " (" + result.country + ")"
      );
      applyDetectedMode(result.ip, result.country);
    }
  );
}

function retryOrUseSafeRule(attempt, reason) {
  recordFailure(attempt, reason);
  if (attempt >= CONFIG.maxAttempts) {
    finishWithSafeRule("IPPure 连续检测失败");
    return;
  }

  setTimeout(function () {
    requestIPPure(attempt + 1);
  }, CONFIG.retryDelayMs * attempt);
}

function postStatus(ip, country, targetMode) {
  var modeName = targetMode === "rule" ? "Rule" : "DIRECT";
  $notification.post("出口信息", "IP：" + ip, "国家：" + country + " · " + modeName);
}

function notifySwitchFailure(message) {
  console.log("[IPPure 出口模式] " + message);
  $notification.post("Surge 出站模式切换失败", "请检查 Surge 日志", message);
  finish();
}

function setModeAndVerify(targetMode, callback) {
  if (stopIfStale()) return;

  $httpAPI("GET", "/v1/outbound", null, function (current) {
    if (stopIfStale()) return;
    if (current && current.mode === targetMode) {
      callback(true, false);
      return;
    }

    $httpAPI("POST", "/v1/outbound", { mode: targetMode }, function () {
      if (stopIfStale()) return;
      $httpAPI("GET", "/v1/outbound", null, function (verified) {
        if (stopIfStale()) return;
        callback(Boolean(verified && verified.mode === targetMode), true);
      });
    });
  });
}

function establishSafeBaseline(callback) {
  setModeAndVerify("rule", function (success, changed) {
    if (!success) {
      notifySwitchFailure("无法建立 Rule 安全模式");
      return;
    }
    baselineChanged = changed;
    callback();
  });
}

function applyDetectedMode(ip, country) {
  if (finalizing || stopIfStale()) return;
  finalizing = true;
  var targetMode = country === "CN" ? "rule" : "direct";

  setModeAndVerify(targetMode, function (success, changed) {
    if (!success) {
      notifySwitchFailure(
        ip + " (" + country + ") 应切换为 " + targetMode + "，但结果未通过验证"
      );
      return;
    }

    console.log("[IPPure 出口模式] " + ip + " (" + country + ") -> " + targetMode);
    if (changed || (targetMode === "rule" && baselineChanged)) {
      postStatus(ip, country, targetMode);
    }
    finish();
  });
}

function finishWithSafeRule(reason) {
  if (finished || finalizing || !isLatestExecution()) {
    if (!finalizing) finish();
    return;
  }
  finalizing = true;

  setModeAndVerify("rule", function (success) {
    if (!success) {
      notifySwitchFailure(reason + "，且无法切换到 Rule 安全模式");
      return;
    }

    var detail = lastFailure || reason;
    console.log("[IPPure 出口模式] " + reason + "，已使用 Rule 安全模式；" + detail);
    $notification.post(
      "IPPure 出口检测失败",
      "已安全使用 Rule 模式",
      reason + "；" + detail
    );
    finish();
  });
}

watchdog = setTimeout(function () {
  if (finished) return;
  finishWithSafeRule("IPPure 出口检测超时");
}, CONFIG.watchdogMs);

establishSafeBaseline(function () {
  setTimeout(function () {
    requestIPPure(1);
  }, CONFIG.settleDelayMs);
});
