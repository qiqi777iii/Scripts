"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.View = void 0;
const scripting_1 = require("scripting");
function windowLabel(window) {
    const seconds = Number(window?.limit_window_seconds || 0);
    if (seconds > 0 && seconds <= 6 * 3600)
        return "5 小时";
    if (seconds >= 27 * 86400)
        return "月限";
    if (seconds >= 6 * 86400)
        return "周限";
    if (seconds >= 86400)
        return `${Math.round(seconds / 86400)} 天`;
    if (seconds >= 3600)
        return `${Math.round(seconds / 3600)} 小时`;
    return "额度";
}
function remainingPercent(window) {
    return Math.max(0, Math.min(100, Math.round(100 - Number(window?.used_percent || 0))));
}
function resetText(ts) {
    if (!ts)
        return "等待更新";
    const date = new Date(ts * 1000);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return date.toLocaleString("zh-CN", sameDay
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
function View({ accounts }) {
    return createElement(scripting_1.VStack, { padding: 12, alignment: "leading", spacing: 6 },
        createElement(scripting_1.HStack, { spacing: 5 },
            createElement(scripting_1.Image, { resizable: true, scaleToFit: true, frame: { width: 20, height: 20 }, filePath: {
                    light: scripting_1.Script.directory + "/image/light.png",
                    dark: scripting_1.Script.directory + "/image/dark.png",
                } }),
            createElement(scripting_1.Text, { font: "subheadline", fontWeight: "bold", lineLimit: 1 }, "Codex 额度"),
            createElement(scripting_1.Spacer, { minLength: 4 }),
            createElement(scripting_1.Image, { systemName: "arrow.clockwise", font: "caption2", foregroundStyle: "secondaryLabel" })),
        accounts.map((account) => createElement(AccountRow, { account })));
}
exports.View = View;
function AccountRow({ account }) {
    if (!account.usage) {
        return createElement(scripting_1.VStack, { alignment: "leading", spacing: 3, padding: { horizontal: 8, vertical: 6 }, background: { light: "secondarySystemBackground", dark: "rgba(255,255,255,0.055)" }, clipShape: { type: "rect", cornerRadius: 9 } },
            createElement(scripting_1.HStack, null,
                createElement(scripting_1.Text, { font: "caption", fontWeight: "semibold" }, `账号 ${account.slot}`),
                createElement(scripting_1.Spacer, null),
                createElement(scripting_1.Text, { font: "caption2", foregroundStyle: account.configured ? "orange" : "secondaryLabel" }, account.configured ? "需重新授权" : "未添加")));
    }
    const primary = account.usage.rate_limit?.primary_window || null;
    const secondary = account.usage.rate_limit?.secondary_window || null;
    const windows = [primary, secondary].filter(Boolean).sort((a, b) => Number(a.limit_window_seconds || 0) - Number(b.limit_window_seconds || 0));
    return createElement(scripting_1.VStack, { alignment: "leading", spacing: 3, padding: { horizontal: 8, vertical: 5 }, background: { light: "secondarySystemBackground", dark: "rgba(255,255,255,0.055)" }, clipShape: { type: "rect", cornerRadius: 9 } },
        createElement(scripting_1.HStack, { spacing: 4 },
            createElement(scripting_1.Text, { font: "caption", fontWeight: "bold" }, `账号 ${account.slot}`),
            account.usage.plan ? createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "tintColor" }, account.usage.plan) : null,
            createElement(scripting_1.Spacer, null),
            account.stale ? createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "orange" }, "缓存") : null),
        windows.length ? createElement(scripting_1.HStack, { spacing: 8 }, windows.map((window) => createElement(LimitItem, { window }))) : createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "secondaryLabel" }, "暂无额度窗口"));
}
function LimitItem({ window }) {
    const percent = remainingPercent(window);
    return createElement(scripting_1.VStack, { alignment: "leading", spacing: 1, frame: { maxWidth: Infinity, alignment: "leading" } },
        createElement(scripting_1.HStack, { spacing: 3 },
            createElement(scripting_1.Text, { font: { name: "System", size: 11 }, foregroundStyle: "secondaryLabel", lineLimit: 1, minScaleFactor: 0.8 }, windowLabel(window)),
            createElement(scripting_1.Spacer, { minLength: 2 }),
            createElement(scripting_1.Text, { font: "caption", fontWeight: "bold", monospacedDigit: true, foregroundStyle: percent <= 20 ? "orange" : "label" }, `${percent}%`)),
        createElement(scripting_1.ProgressView, { value: percent, total: 100, tint: percent <= 20 ? "orange" : "tintColor", frame: { maxWidth: Infinity } }),
        createElement(scripting_1.Text, { font: { name: "System", size: 10 }, foregroundStyle: "secondaryLabel", lineLimit: 1, minScaleFactor: 0.75, monospacedDigit: true }, `重置 ${resetText(window.reset_at)}`));
}
