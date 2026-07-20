"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = { enumerable: true, get: function() { return m[k]; } };
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) { if (k2 === undefined) k2 = k; o[k2] = m[k]; }));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) { Object.defineProperty(o, "default", { enumerable: true, value: v }); }) : function(o, v) { o["default"] = v; });
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
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
const scripting_1 = require("scripting");
const app_intents_1 = require("./app_intents");
const api_1 = require("./class/api");
const circular_1 = require("./widget/circular");
const small_1 = require("./widget/small");
function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms))]);
}
(() => __awaiter(void 0, void 0, void 0, function* () {
    let accounts = api_1.api.getAccountStates().map((state) => Object.assign(Object.assign({}, state), { stale: !!state.usage }));
    try {
        const live = yield withTimeout(api_1.api.getAllUsage(), 12000);
        accounts = live.map((item) => ({ slot: item.slot, configured: item.configured, usage: item.usage, stale: !!item.error }));
    }
    catch (_) {
        // 网络超时保留每个账号各自的缓存，不让整个小组件失效。
    }
    const first = accounts.find((a) => a.usage);
    const percent = Math.max(0, Math.min(100, Math.round(100 - (first?.usage?.rate_limit?.primary_window?.used_percent || 0))));
    switch (scripting_1.Widget.family) {
        case "accessoryCircular":
            scripting_1.Widget.present(createElement(scripting_1.Button, { intent: (0, app_intents_1.ReloadIntent)(undefined), buttonStyle: "plain" }, createElement(circular_1.View, { percent })));
            break;
        case "systemSmall":
            scripting_1.Widget.present(createElement(scripting_1.Button, { intent: (0, app_intents_1.ReloadIntent)(undefined), buttonStyle: "plain" }, createElement(small_1.View, { accounts })));
            break;
        default:
            throw new Error("未适配的 Widget 尺寸");
    }
}))().catch((e) => __awaiter(void 0, void 0, void 0, function* () {
    const { Text, VStack } = yield Promise.resolve().then(() => __importStar(require("scripting")));
    scripting_1.Widget.present(createElement(VStack, { padding: true }, createElement(Text, { font: "caption", foregroundStyle: "red" }, String(e))));
}));
