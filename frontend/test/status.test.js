'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const status = (page) => page.textContent('#save-status');

test('status line says where each page lives', async () => {
    const page = await h.open(h.standardSeed({
        docs: h.standardSeed().docs.concat([{ id: 'd4', title: 'Changed', content: 'x\n', status: 'draft', driveFileId: 'drv-d4' }]),
    }));
    await h.openWorkspace(page);

    await h.openPage(page, 'Q4 Roadmap');
    assert.strictEqual(await status(page), 'Published · up to date');
    assert.ok(await page.isHidden('#btn-publish'));

    await h.openPage(page, 'Meeting Notes');
    assert.strictEqual(await status(page), 'Saved on this PC · not published');
    assert.strictEqual(await page.textContent('#btn-publish'), 'Publish');

    await h.openPage(page, 'Changed');
    assert.strictEqual(await status(page), 'Published · edits not published');
    assert.strictEqual(await page.textContent('#btn-publish'), 'Publish Changes');
});

test('editing a published page moves through Unsaved, Saving, edits not published; Publish returns to up to date', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');

    await page.click('#editor .ProseMirror p');
    await page.keyboard.type('!');
    assert.strictEqual(await status(page), 'Unsaved changes');
    assert.ok(await page.isVisible('#btn-publish'), 'Publish appears on first edit');
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Published · edits not published');

    await page.click('#btn-publish');
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Published · up to date');
    assert.ok(await page.isHidden('#btn-publish'));
});

test('a failed local save shows Couldn’t save', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.evaluate(() => { window.__S.fail.UpdateDocument = 'database is locked'; });
    await page.click('#editor .ProseMirror p');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Couldn’t save');
});

test('sync icon says Refresh from Drive', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    assert.match(await page.getAttribute('#btn-sync', 'title'), /^Refresh from Drive/);
});

test('draft hint shows on a new page, and dismissal persists', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click('#btn-new-page');
    await page.waitForSelector('#draft-hint:not(.hidden)');
    assert.match(await page.textContent('#draft-hint'), /Pages stay on this PC until you Publish\. Teammates see published pages when they Refresh\./);

    await h.openPage(page, 'Q4 Roadmap');
    assert.ok(await page.isHidden('#draft-hint'), 'not on published pages');

    await h.openPage(page, 'Meeting Notes');
    await page.click('#btn-dismiss-draft-hint');
    assert.ok(await page.isHidden('#draft-hint'));
    assert.deepStrictEqual((await h.calls(page, 'SetUIState')).map((c) => c.args), [['draft-hint-dismissed', '1']]);

    // New session with the flag stored: no hint.
    const page2 = await h.open(h.standardSeed({ ui: { 'draft-hint-dismissed': '1' } }));
    await h.openWorkspace(page2);
    await h.openPage(page2, 'Meeting Notes');
    assert.ok(await page2.isHidden('#draft-hint'));
});
