"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.View = void 0;
const scripting_1 = require("scripting");
function fmt(ts) {
    return ts ? new Date(ts * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function View({ accounts }) {
    return createElement(scripting_1.VStack, { padding: true, alignment: "leading", spacing: 7 },
        createElement(scripting_1.HStack, null,
            createElement(scripting_1.Image, { systemName: "bolt.fill", foregroundStyle: "tintColor", frame: { width: 15, height: 15 } }),
            createElement(scripting_1.Text, { font: "headline" }, "Codex 额度"),
            createElement(scripting_1.Spacer, null),
            createElement(scripting_1.Image, { systemName: "arrow.clockwise", font: "caption", foregroundStyle: "secondaryLabel" })),
        createElement(scripting_1.Divider, null),
        accounts.map((account) => createElement(AccountRow, { account })));
}
exports.View = View;
function AccountRow({ account }) {
    if (!account.usage) {
        return createElement(scripting_1.HStack, null,
            createElement(scripting_1.Text, { font: "caption", fontWeight: "semibold" }, `账号 ${account.slot}`),
            createElement(scripting_1.Spacer, null),
            createElement(scripting_1.Text, { font: "caption2", foregroundStyle: account.configured ? "orange" : "secondaryLabel" }, account.configured ? "需重新授权" : "未添加"));
    }
    const primary = account.usage.rate_limit?.primary_window || null;
    const secondary = account.usage.rate_limit?.secondary_window || null;
    const primaryPercent = Math.round(primary?.used_percent || 0);
    const secondaryPercent = secondary ? Math.round(secondary.used_percent || 0) : null;
    return createElement(scripting_1.VStack, { alignment: "leading", spacing: 3 },
        createElement(scripting_1.HStack, null,
            createElement(scripting_1.Text, { font: "caption", fontWeight: "semibold", lineLimit: 1, minScaleFactor: 0.7 }, `账号 ${account.slot}  ${account.usage.email || account.usage.plan || "ChatGPT"}`),
            createElement(scripting_1.Spacer, { minLength: 4 }),
            account.stale ? createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "orange" }, "缓存") : null),
        createElement(scripting_1.HStack, { spacing: 5 },
            createElement(MiniProgress, { label: "5h", percent: primaryPercent }),
            secondaryPercent != null ? createElement(MiniProgress, { label: "7d", percent: secondaryPercent }) : null),
        createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "secondaryLabel", lineLimit: 1, minScaleFactor: 0.6, monospacedDigit: true }, `5h ${fmt(primary?.reset_at || null)}${secondary ? `  ·  7d ${fmt(secondary.reset_at)}` : ""}`));
}
function MiniProgress({ label, percent }) {
    return createElement(scripting_1.HStack, { spacing: 3 },
        createElement(scripting_1.Text, { font: "caption2", foregroundStyle: "secondaryLabel" }, label),
        createElement(scripting_1.Text, { font: "caption", fontWeight: "semibold", monospacedDigit: true }, `${percent}%`));
}
