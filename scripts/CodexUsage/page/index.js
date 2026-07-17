"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.View = void 0;
const scripting_1 = require("scripting");
const api_1 = require("../class/api");
function View() {
    const dismiss = scripting_1.Navigation.useDismiss();
    const reloadKey = (0, scripting_1.useObservable)(0);
    return createElement(scripting_1.NavigationStack, null,
        createElement(StackView, { reloadKey: reloadKey.value, navigationTitle: scripting_1.Script.name, toolbar: {
                topBarLeading: [createElement(scripting_1.Button, { title: "关闭", systemImage: "xmark", action: dismiss })],
                topBarTrailing: [createElement(scripting_1.Button, { title: "账号", systemImage: "person.2", action: () => scripting_1.Navigation.present(createElement(AccountView, { onChanged: () => reloadKey.setValue(reloadKey.value + 1) })) })],
            } }));
}
exports.View = View;
function AccountView({ onChanged }) {
    const dismiss = scripting_1.Navigation.useDismiss();
    const reloadKey = (0, scripting_1.useObservable)(0);
    function refresh(message) {
        return __awaiter(this, void 0, void 0, function* () {
            scripting_1.Widget.reloadUserWidgets();
            onChanged();
            reloadKey.setValue(reloadKey.value + 1);
            if (message)
                yield Dialog.alert({ message });
        });
    }
    const states = api_1.api.getAccountStates();
    return createElement(scripting_1.NavigationStack, null,
        createElement(scripting_1.List, { navigationTitle: "账号管理", toolbar: { topBarLeading: [createElement(scripting_1.Button, { title: "关闭", systemImage: "xmark", action: dismiss })] } },
            states.map((state) => createElement(scripting_1.Section, { header: createElement(scripting_1.Text, null, `账号 ${state.slot}`), footer: createElement(scripting_1.Text, null, state.configured ? (state.usage?.email || "凭证已保存") : "未添加") },
                createElement(scripting_1.Button, { title: state.configured ? "重新授权 / 替换" : "添加账号", systemImage: "person.crop.circle.badge.plus", action: () => __awaiter(this, void 0, void 0, function* () {
                        const ok = yield api_1.api.presentLogin(state.slot);
                        yield refresh(ok ? `账号 ${state.slot} 已保存` : "未保存新凭证，原账号仍保留");
                    }) }),
                state.configured ? createElement(scripting_1.Button, { title: "删除此账号", systemImage: "trash", role: "destructive", action: () => __awaiter(this, void 0, void 0, function* () {
                        yield api_1.api.clearSavedAccount(state.slot);
                        yield refresh(`账号 ${state.slot} 已删除`);
                    }) }) : null)),
            createElement(scripting_1.Section, { footer: createElement(scripting_1.Text, null, "两个账号的 accessToken、额度缓存分别保存在本机。添加第二个账号不会覆盖第一个；网页登录 Cookie 仅用于授权，额度刷新直接使用各自凭证。") },
                createElement(scripting_1.Button, { title: "退出 ChatGPT 网页登录", systemImage: "rectangle.portrait.and.arrow.right", action: () => __awaiter(this, void 0, void 0, function* () {
                        yield api_1.api.clearWebLoginState();
                        yield Dialog.alert({ message: "已退出网页登录，两个本地账号凭证仍保留" });
                    }) }))));
}
function StackView({ reloadKey }) {
    const rows = (0, scripting_1.useObservable)();
    function init() {
        return __awaiter(this, void 0, void 0, function* () {
            const cached = api_1.api.getAccountStates();
            rows.setValue(cached);
            const refreshed = yield api_1.api.getAllUsage();
            rows.setValue(refreshed.map((item) => ({
                slot: item.slot,
                configured: item.configured,
                usage: item.usage,
                error: item.error,
            })));
            scripting_1.Widget.reloadUserWidgets();
        });
    }
    (0, scripting_1.useEffect)(() => { init(); }, [reloadKey]);
    if (rows.value === undefined)
        return createElement(scripting_1.ProgressView, null);
    return createElement(scripting_1.List, { refreshable: () => __awaiter(this, void 0, void 0, function* () { yield Promise.all([init(), new Promise((r) => setTimeout(r, 500))]); }) },
        rows.value.map((item) => item.usage
            ? createElement(UsageSection, { slot: item.slot, usage: item.usage, stale: !!item.error })
            : createElement(scripting_1.Section, { header: createElement(scripting_1.Text, null, `账号 ${item.slot}`) },
                createElement(scripting_1.ContentUnavailableView, { label: createElement(scripting_1.Label, { title: item.configured ? "凭证已失效" : "尚未添加", systemImage: "person.crop.circle.badge.plus" }), actions: [createElement(scripting_1.Button, { title: item.configured ? "重新授权" : "添加账号", action: () => __awaiter(this, void 0, void 0, function* () {
                                const ok = yield api_1.api.presentLogin(item.slot);
                                if (!ok)
                                    yield Dialog.alert({ message: "凭证获取失败，原账号未受影响" });
                                yield init();
                            }) })] }))));
}
function UsageSection({ slot, usage, stale }) {
    const primary = usage.rate_limit?.primary_window || null;
    const secondary = usage.rate_limit?.secondary_window || null;
    const primaryPercent = Math.round(primary?.used_percent || 0);
    return createElement(Fragment, null,
        createElement(scripting_1.Section, { header: createElement(scripting_1.HStack, null,
                createElement(scripting_1.Text, null, `账号 ${slot} · ${usage.email || "ChatGPT"}`),
                createElement(scripting_1.Spacer, null),
                stale ? createElement(scripting_1.Text, { foregroundStyle: "orange" }, "缓存") : null,
                createElement(scripting_1.Text, null, usage.plan)), footer: createElement(scripting_1.Text, null, primary ? "重置: " + new Date(primary.reset_at * 1000).toLocaleString("zh-CN") : "无主窗口数据") },
            createElement(Bar, { label: "主窗口", percent: primaryPercent })),
        secondary ? createElement(scripting_1.Section, { footer: createElement(scripting_1.Text, null, "重置: " + new Date(secondary.reset_at * 1000).toLocaleString("zh-CN")) },
            createElement(Bar, { label: `账号 ${slot} 周限制`, percent: Math.round(secondary.used_percent) })) : null);
}
function Bar({ label, percent }) {
    return createElement(scripting_1.HStack, { spacing: 10 },
        createElement(scripting_1.Text, { font: "footnote", foregroundStyle: "secondaryLabel", frame: { width: 90, alignment: "leading" } }, label),
        createElement(scripting_1.Rectangle, { frame: { height: 22 }, fill: "tertiarySystemFill", clipShape: { type: "capsule", style: "continuous" }, overlay: createElement(scripting_1.Rectangle, { fill: { gradient: true, color: "tintColor" }, scaleEffect: { x: percent / 100, y: 1, anchor: "leading" }, clipShape: { type: "capsule", style: "continuous" } }) }),
        createElement(scripting_1.Text, { font: "footnote", monospacedDigit: true, frame: { width: 42, alignment: "trailing" } }, `${percent}%`));
}
