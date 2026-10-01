"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

const matchPatternToRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/**
 * Browser state that outlives the background script: tabs and extension storage.
 * `session` is the storage.session area, kept for the whole browser session.
 */
const createBrowser = ({ tabs, local = {} }) => ({ tabs, local, session: {}, lastError: undefined });

const activeTab = (browser) => browser.tabs.find(tab => tab.active);

const withLastError = (browser, message, callback) => {
    browser.lastError = message ? { message } : undefined;
    try {
        if (callback) callback();
    } finally {
        browser.lastError = undefined;
    }
};

const pick = (store, keys) => {
    if (keys === null || typeof keys === "undefined") return { ...store };
    const result = {};
    for (const key of [].concat(keys)) if (key in store) result[key] = store[key];
    return result;
};

const buildOverrides = (browser) => {
    const query = (info, callback) => {
        const urlRegex = info.url ? matchPatternToRegex(info.url) : null;
        const found = browser.tabs.filter(tab =>
            (info.windowId === null || typeof info.windowId === "undefined" || tab.windowId === info.windowId) &&
            (typeof info.active === "undefined" || tab.active === info.active) &&
            (!urlRegex || urlRegex.test(tab.url)));
        callback(found.map(tab => ({ ...tab })));
    };
    const get = (tabId, callback) => {
        const tab = browser.tabs.find(candidate => candidate.id === tabId);
        withLastError(browser, tab ? null : `Invalid tab ID: ${tabId}`, () => callback(tab && { ...tab }));
    };
    // Like the browser, closing the active tab hands focus to another tab on its own.
    const remove = (tabIds, callback) => {
        for (const tabId of [].concat(tabIds)) {
            const index = browser.tabs.findIndex(tab => tab.id === tabId);
            if (index === -1) continue;
            const [removed] = browser.tabs.splice(index, 1);
            if (removed.active && browser.tabs.length) browser.tabs[0].active = true;
        }
        withLastError(browser, null, callback);
        return Promise.resolve();
    };
    const update = (tabId, properties, callback) => {
        const tab = browser.tabs.find(candidate => candidate.id === tabId);
        if (tab && properties.active) browser.tabs.forEach(candidate => { candidate.active = candidate === tab; });
        withLastError(browser, tab ? null : `Invalid tab ID: ${tabId}`, callback);
    };
    return {
        "tabs.query": query,
        "tabs.get": get,
        "tabs.remove": remove,
        "tabs.update": update,
        "windows.getLastFocused": (_, callback) => callback({ id: 1 }),
        "windows.getAll": (_, callback) => callback([{ id: 1 }]),
        "storage.local.get": (keys, callback) => callback(pick(browser.local, keys)),
        "storage.local.set": (items, callback) => {
            Object.assign(browser.local, items);
            if (callback) callback();
        },
        "storage.session.get": async (keys) => pick(browser.session, keys),
        "storage.session.set": async (items) => {
            Object.assign(browser.session, items);
        },
        "runtime.getContexts": async () => [],
        "runtime.getURL": (file) => `moz-extension://dtc/${file}`,
    };
};

// Every API not listed in the overrides resolves to nothing; listeners are recorded for dispatch().
const createApi = (browser, listeners) => {
    const overrides = buildOverrides(browser);
    const node = (apiPath) => new Proxy(function () {}, {
        get(_, property) {
            const fullPath = apiPath ? `${apiPath}.${String(property)}` : String(property);
            if (fullPath === "runtime.lastError") return browser.lastError;
            if (fullPath in overrides) return overrides[fullPath];
            if (property === "then") return undefined;
            if (property === "addListener") return (listener) => {
                (listeners[apiPath] ||= []).push(listener);
            };
            return node(fullPath);
        },
        apply(_, __, args) {
            const callback = args[args.length - 1];
            if (typeof callback === "function") callback();
            return Promise.resolve();
        }
    });
    return node("");
};

/**
 * Loads the background scripts in a fresh global, as the browser does on startup and
 * again each time it wakes the idle-suspended background.
 */
const startBackground = async (browser) => {
    const listeners = {};
    const api = createApi(browser, listeners);
    const context = vm.createContext({
        chrome: api,
        browser: api,
        navigator: { userAgent: "Mozilla/5.0 Firefox/156.0" },
        console: process.env.DTC_TEST_LOG ? console : { log() {}, warn() {}, error() {} },
        setTimeout: (callback, delay) => setTimeout(callback, delay).unref(),
        clearTimeout,
        URL
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest-f.json"), "utf8"));
    for (const script of manifest.background.scripts) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
    }
    await vm.runInContext("ensureInitialized()", context);
    return {
        dispatch: (event, ...args) => Promise.all((listeners[event] || []).map(listener => listener(...args)))
    };
};

const until = async (condition, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

module.exports = { createBrowser, startBackground, activeTab, until };
