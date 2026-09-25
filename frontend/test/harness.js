// Playwright harness: loads frontend/dist in Chromium with the mock backend
// from mock-backend.js standing in for the Wails Go bindings.
//
// Run all UI tests from the repo root:
//   node --test frontend/test/
// Playwright is resolved from NODE_PATH or PLAYWRIGHT_PATH, e.g.
//   NODE_PATH=$(npm root -g) node --test frontend/test/

'use strict';

const fs = require('fs');
const path = require('path');

function loadPlaywright() {
    const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright'];
    for (const c of candidates) {
        if (!c) continue;
        try { return require(c); } catch (e) { /* try next */ }
    }
    throw new Error('Playwright not found. Install it (npm i -g playwright) and set NODE_PATH or PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();

const DIST = path.resolve(__dirname, '..', 'dist');
const MOCK = path.join(__dirname, 'mock-backend.js');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let browser = null;

async function getBrowser() {
    if (!browser) browser = await chromium.launch();
    return browser;
}

async function closeBrowser() {
    if (browser) { await browser.close(); browser = null; }
}

// open() starts a fresh page. `seed` preloads mock state (auth, workspaces,
// docs, settings, revisions). The returned page has pageerror tracking in
// page.__errors so tests can assert no uncaught exceptions happened.
async function open(seed, opts) {
    opts = opts || {};
    const b = await getBrowser();
    const context = await b.newContext({ viewport: opts.viewport || { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.__errors = [];
    page.on('pageerror', (err) => page.__errors.push(String(err)));
    page.on('console', (msg) => { if (process.env.HARNESS_VERBOSE) console.log('[browser]', msg.text()); });

    await page.route('http://hexnote.local/**', async (route) => {
        const url = new URL(route.request().url());
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/') rel = '/index.html';
        const file = path.join(DIST, rel);
        if (!file.startsWith(DIST) || !fs.existsSync(file)) {
            return route.fulfill({ status: 404, body: 'not found' });
        }
        return route.fulfill({
            status: 200,
            contentType: TYPES[path.extname(file)] || 'application/octet-stream',
            body: fs.readFileSync(file),
        });
    });

    await page.addInitScript((s) => { window.__HEXNOTE_SEED = s; }, seed || {});
    if (opts.beforeMock) await page.addInitScript(opts.beforeMock);
    await page.addInitScript({ path: MOCK });
    await page.goto('http://hexnote.local/');
    return page;
}

// Standard seed: one workspace with a published page, a draft page and a folder.
function standardSeed(extra) {
    return Object.assign({
        docs: [
            { id: 'd1', title: 'Q4 Roadmap', content: '# Q4 Roadmap\n\nShip v0.2 by December.\n', status: 'published', driveFileId: 'drv-d1' },
            { id: 'd2', title: 'Meeting Notes', content: 'Some notes.\n', status: 'draft' },
            { id: 'f1', title: 'Design', isFolder: true, status: 'published', driveFileId: 'drv-f1' },
            { id: 'd3', title: 'Art Bible', content: 'Colours.\n', parentId: 'f1', status: 'published', driveFileId: 'drv-d3' },
        ],
    }, extra || {});
}

async function openWorkspace(page, name) {
    await page.click('.workspace-card:has-text("' + (name || 'Studio Wiki') + '")');
    await page.waitForSelector('#view-editor:not(.hidden)');
}

async function openPage(page, title) {
    await page.click('.tree-item:has-text("' + title + '")');
    await page.waitForFunction((t) => document.getElementById('doc-title').value === t, title);
}

async function calls(page, name) {
    return page.evaluate((n) => window.__S.calls.filter((c) => !n || c.name === n), name || null);
}

async function clearCalls(page) {
    await page.evaluate(() => { window.__S.calls = []; });
}

module.exports = { open, standardSeed, openWorkspace, openPage, calls, clearCalls, closeBrowser };
