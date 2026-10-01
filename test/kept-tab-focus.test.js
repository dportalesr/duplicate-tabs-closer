"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, startBackground, activeTab, until } = require("./support/fake-browser");

const PAGE = "https://example.com/reading";
const TICKET = "https://example.com/ticket";

const tab = (id, url, overrides = {}) => ({
    id,
    windowId: 1,
    index: id - 1,
    url,
    status: "complete",
    active: false,
    pinned: false,
    hidden: false,
    discarded: false,
    lastAccessed: id * 1000,
    cookieStoreId: "firefox-default",
    ...overrides
});

const autoClose = () => ({ onDuplicateTabDetected: { value: "A" }, keepActiveTab: { value: false } });

const openInForeground = (browser, newTab) => {
    browser.tabs.forEach(candidate => { candidate.active = false; });
    browser.tabs.push({ ...newTab, active: true });
};

const finishLoading = (browser, tabId, url) => Object.assign(browser.tabs.find(candidate => candidate.id === tabId), { url, status: "complete" });

test("duplicate opened after the idle background wakes up: closed and the kept tab gets focus", async () => {
    const browser = createBrowser({
        tabs: [tab(1, PAGE, { active: true }), tab(2, TICKET)],
        local: autoClose()
    });
    await startBackground(browser);

    openInForeground(browser, tab(3, "about:blank", { status: "loading" }));
    const background = await startBackground(browser);
    await background.dispatch("tabs.onCreated", { ...browser.tabs[2] });
    await background.dispatch("webNavigation.onBeforeNavigate", { tabId: 3, frameId: 0, url: TICKET });
    if (browser.tabs.some(candidate => candidate.id === 3)) {
        finishLoading(browser, 3, TICKET);
        await background.dispatch("webNavigation.onCompleted", { tabId: 3, frameId: 0, url: TICKET });
    }

    await until(() => !browser.tabs.some(candidate => candidate.id === 3));
    await until(() => activeTab(browser).id === 2, 500);
});

test("duplicates restored at browser startup: batch closed without moving focus", async () => {
    const browser = createBrowser({
        tabs: [tab(1, PAGE, { active: true }), tab(2, TICKET), tab(3, "about:blank", { status: "loading" })],
        local: autoClose()
    });
    const background = await startBackground(browser);

    await background.dispatch("webNavigation.onBeforeNavigate", { tabId: 3, frameId: 0, url: TICKET });
    finishLoading(browser, 3, TICKET);
    await background.dispatch("webNavigation.onCompleted", { tabId: 3, frameId: 0, url: TICKET });

    await until(() => browser.tabs.length === 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(browser.tabs.map(candidate => candidate.id), [1, 2]);
    assert.equal(activeTab(browser).id, 1);
});
