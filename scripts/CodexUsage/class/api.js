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
exports.api = void 0;
const scripting_1 = require("scripting");
const LEGACY = {
    login: "codex_logged_in",
    cache: "codex_usage_cache",
    cookies: "codex_saved_cookies",
    token: "codex_access_token",
};
const MIGRATED_KEY = "codex_accounts_v2_migrated";
const SLOTS = [1, 2];
function key(slot, name) {
    return `codex_account_${slot}_${name}`;
}
class API {
    constructor() {
        this.base = "https://chatgpt.com";
        this.migrateLegacyAccount();
    }
    migrateLegacyAccount() {
        if (Storage.get(MIGRATED_KEY) === true)
            return;
        const token = Storage.get(LEGACY.token) || "";
        const cache = Storage.get(LEGACY.cache) || null;
        const cookies = Storage.get(LEGACY.cookies) || [];
        if (token)
            Storage.set(key(1, "token"), token);
        if (cache)
            Storage.set(key(1, "cache"), cache);
        if (cookies.length)
            Storage.set(key(1, "cookies"), cookies);
        Storage.set(key(1, "logged_in"), Storage.get(LEGACY.login) === true || !!token);
        Storage.set(MIGRATED_KEY, true);
    }
    validSlot(slot) {
        return slot === 2 ? 2 : 1;
    }
    hasLogin(slot = 1) {
        slot = this.validSlot(slot);
        return Storage.get(key(slot, "logged_in")) === true && !!this.getSavedToken(slot);
    }
    markLogin(slot, value) {
        Storage.set(key(this.validSlot(slot), "logged_in"), value);
    }
    getCached(slot = 1) {
        return Storage.get(key(this.validSlot(slot), "cache")) || null;
    }
    writeCache(slot, usage) {
        Storage.set(key(this.validSlot(slot), "cache"), { usage, ts: Date.now() });
    }
    getSavedToken(slot = 1) {
        return Storage.get(key(this.validSlot(slot), "token")) || "";
    }
    saveToken(slot, token) {
        Storage.set(key(this.validSlot(slot), "token"), token || "");
    }
    getSavedCookies(slot = 1) {
        return Storage.get(key(this.validSlot(slot), "cookies")) || [];
    }
    getAccountStates() {
        return SLOTS.map((slot) => {
            const cached = this.getCached(slot);
            return {
                slot,
                configured: !!this.getSavedToken(slot),
                usage: cached ? cached.usage : null,
                ts: cached ? cached.ts : null,
            };
        });
    }
    getUsageByToken(token) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield (0, scripting_1.fetch)(`${this.base}/backend-api/wham/usage`, {
                headers: { accept: "application/json", authorization: `Bearer ${token}` },
            });
            if (response.status === 401 || response.status === 403) {
                const err = new Error("TOKEN_INVALID");
                err.tokenInvalid = true;
                throw err;
            }
            if (!response.ok)
                throw new Error(`HTTP_${response.status}`);
            const usage = yield response.json();
            const rl = usage.rate_limit || {};
            return {
                email: usage.email || "",
                plan: normalizePlan(usage.plan_type || ""),
                rate_limit: {
                    primary_window: rl.primary_window || null,
                    secondary_window: rl.secondary_window || null,
                },
            };
        });
    }
    getUsage(slot = 1) {
        return __awaiter(this, void 0, void 0, function* () {
            slot = this.validSlot(slot);
            const token = this.getSavedToken(slot);
            if (!token) {
                this.markLogin(slot, false);
                const err = new Error("NEED_LOGIN");
                err.needLogin = true;
                err.slot = slot;
                throw err;
            }
            try {
                const usage = yield this.getUsageByToken(token);
                this.markLogin(slot, true);
                this.writeCache(slot, usage);
                return usage;
            }
            catch (e) {
                if (e && e.tokenInvalid) {
                    this.saveToken(slot, "");
                    this.markLogin(slot, false);
                    const err = new Error("NEED_LOGIN");
                    err.needLogin = true;
                    err.slot = slot;
                    throw err;
                }
                throw e;
            }
        });
    }
    getAllUsage() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield Promise.all(SLOTS.map((slot) => __awaiter(this, void 0, void 0, function* () {
                if (!this.getSavedToken(slot))
                    return { slot, configured: false, usage: null, error: null };
                try {
                    const usage = yield this.getUsage(slot);
                    return { slot, configured: true, usage, error: null };
                }
                catch (error) {
                    return { slot, configured: !!this.getSavedToken(slot), usage: this.getCached(slot)?.usage || null, error };
                }
            })));
        });
    }
    saveCookies(wv, slot) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const cookies = yield wv.getCookies(this.base);
                Storage.set(key(this.validSlot(slot), "cookies"), cookies.map((c) => (Object.assign(Object.assign({}, c), { expiresDate: c.expiresDate ? new Date(c.expiresDate).toISOString() : null }))));
            }
            catch (_) { }
        });
    }
    readSessionToken(wv) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const raw = yield wv.evaluateJavaScript(`
          return (async () => {
            try {
              const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
              return JSON.stringify({ token: s.accessToken || '' });
            } catch (e) { return JSON.stringify({ token: '', error: String(e) }); }
          })();
        `);
                return JSON.parse(raw).token || "";
            }
            catch (_) {
                return "";
            }
        });
    }
    clearServiceWebCookies() {
        return __awaiter(this, arguments, void 0, function* (urls = [this.base]) {
            const wv = new WebViewController();
            try {
                const deleted = new Set();
                for (const url of urls) {
                    let cookies = [];
                    try { cookies = yield wv.getCookies(url); }
                    catch (_) { cookies = []; }
                    for (const c of cookies) {
                        const id = `${c.name}|${c.domain}|${c.path}`;
                        if (deleted.has(id))
                            continue;
                        deleted.add(id);
                        try { yield wv.deleteCookie({ name: c.name, domain: c.domain, path: c.path }); }
                        catch (_) { }
                    }
                }
            }
            finally { wv.dispose(); }
        });
    }
    clearWebLoginState() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.clearServiceWebCookies([
                this.base,
                "https://auth.openai.com",
                "https://auth0.openai.com",
                "https://openai.com",
            ]);
        });
    }
    clearSavedAccount(slot) {
        return __awaiter(this, void 0, void 0, function* () {
            slot = this.validSlot(slot);
            this.saveToken(slot, "");
            Storage.set(key(slot, "cookies"), []);
            Storage.set(key(slot, "cache"), null);
            this.markLogin(slot, false);
        });
    }
    presentLogin(slot = 1) {
        return __awaiter(this, void 0, void 0, function* () {
            slot = this.validSlot(slot);
            const oldToken = this.getSavedToken(slot);
            const oldCookies = this.getSavedCookies(slot);
            const oldCache = this.getCached(slot);
            const oldLogin = this.hasLogin(slot);
            const wv = new WebViewController();
            try {
                yield wv.clearAllCookies();
                yield wv.loadURL(`${this.base}/auth/login`);
                yield wv.present({ fullscreen: true, navigationTitle: `登录账号 ${slot}` });
                yield wv.loadURL(`${this.base}/`);
                yield wv.waitForLoad();
                const token = yield this.readSessionToken(wv);
                if (!token)
                    return false;
                this.saveToken(slot, token);
                yield this.saveCookies(wv, slot);
                try {
                    yield this.getUsage(slot);
                    return true;
                }
                catch (_) {
                    this.saveToken(slot, oldToken);
                    Storage.set(key(slot, "cookies"), oldCookies);
                    Storage.set(key(slot, "cache"), oldCache);
                    this.markLogin(slot, oldLogin);
                    return false;
                }
            }
            finally { wv.dispose(); }
        });
    }
}
function normalizePlan(plan) {
    if (!plan)
        return "";
    const p = plan.toLowerCase();
    if (p.includes("pro"))
        return "Pro";
    if (p.includes("team"))
        return "Team";
    if (p.includes("enterprise"))
        return "Enterprise";
    if (p.includes("plus"))
        return "Plus";
    if (p.includes("free"))
        return "Free";
    return plan;
}
exports.api = new API();
