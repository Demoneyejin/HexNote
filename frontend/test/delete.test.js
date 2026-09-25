'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

// Accepts the next confirmation and returns its text. Works for both the
// native confirm() and the in-app confirm sheet.
async function acceptConfirm(page, action) {
    let text = null;
    const onDialog = async (d) => { text = d.message(); await d.accept(); };
    page.once('dialog', onDialog);
    await action();
    const sheet = page.locator('#confirm-sheet:not(.hidden)');
    if (text === null && await sheet.count()) {
        text = (await page.textContent('#confirm-title')) + ' ' + (await page.textContent('#confirm-body'));
        await page.click('#confirm-ok');
    }
    page.off('dialog', onDialog);
    return text;
}

test('deleting a published page names the Drive trash', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');

    const text = await acceptConfirm(page, () => page.click('#btn-delete-doc'));
    assert.match(text, /Drive/);
    assert.match(text, /trash/);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'DeleteDocument'));
    assert.strictEqual(await page.locator('.tree-item:has-text("Q4 Roadmap")').count(), 0);
});

test('deleting a draft says it only exists on this PC', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');

    const text = await acceptConfirm(page, () => page.click('#btn-delete-doc'));
    assert.match(text, /draft/i);
    assert.doesNotMatch(text, /trash/);
});

test('teammate deletion closes the open page and shows a toast', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');

    await page.evaluate(() => {
        delete window.__S.docs.d1;
        window.runtime.EventsEmit('sync:docs-removed', { removed: ['d1'], detached: [] });
    });
    await page.waitForSelector('.toast:has-text("deleted by a teammate")');
    assert.ok(await page.locator('#editor-container.hidden').count(), 'editor should close');
    assert.strictEqual(await page.locator('.tree-item:has-text("Q4 Roadmap")').count(), 0);
});
