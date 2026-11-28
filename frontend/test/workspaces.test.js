'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const TWO = {
    workspaces: [
        { id: 'ws-1', name: 'Studio Wiki', driveFolderId: 'drive-root-1', driveFolderUrl: 'https://drive.google.com/drive/folders/drive-root-1', access: 'owner' },
        { id: 'ws-2', name: 'Publisher Docs', driveFolderId: 'drive-root-2', driveFolderUrl: 'https://drive.google.com/drive/folders/drive-root-2', access: 'reader' },
        { id: 'ws-3', name: 'Old', driveFolderId: 'drive-root-3', driveFolderUrl: 'https://drive.google.com/drive/folders/drive-root-3' },
    ],
};

test('cards show owner/shared tags and Open in Drive', async () => {
    const page = await h.open(TWO);
    await page.waitForSelector('.workspace-card');
    const tags = await page.$$eval('.workspace-card', (cs) => cs.map((c) => (c.querySelector('.ws-tag') || {}).textContent || ''));
    assert.deepStrictEqual(tags, ['Owner', 'Shared · Viewer', '']);

    await page.click('.workspace-card:has-text("Publisher Docs") .ws-drive-link');
    assert.deepStrictEqual(await page.evaluate(() => window.__S.opened), ['https://drive.google.com/drive/folders/drive-root-2']);
    assert.ok(await page.isVisible('#view-workspaces'), 'clicking the link must not open the workspace');
});

test('card menu has Open in Google Drive', async () => {
    const page = await h.open(TWO);
    await page.waitForSelector('.workspace-card');
    await page.click('.workspace-card:has-text("Studio Wiki")', { button: 'right' });
    await page.click('#ws-context-menu [data-action="ws-drive"]');
    assert.deepStrictEqual(await page.evaluate(() => window.__S.opened), ['https://drive.google.com/drive/folders/drive-root-1']);
});

test('sidebar header opens the workspace folder in Drive; opening refreshes members', async () => {
    const page = await h.open(TWO);
    await h.openWorkspace(page, 'Studio Wiki');
    await page.click('#btn-open-drive');
    assert.deepStrictEqual(await page.evaluate(() => window.__S.opened), ['https://drive.google.com/drive/folders/drive-root-1']);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'GetWorkspaceMembers'));
});

test('cards open with the keyboard', async () => {
    const page = await h.open(TWO);
    await page.waitForSelector('.workspace-card');
    await page.focus('.workspace-card:has-text("Studio Wiki")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-editor:not(.hidden)');
});
