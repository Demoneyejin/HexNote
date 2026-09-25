'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

async function renameViaMenu(page, title, newTitle) {
    await page.click('.tree-item:has-text("' + title + '")', { button: 'right' });
    page.once('dialog', (d) => d.accept(newTitle));
    await page.click('#context-menu [data-action="rename"]');
    await page.waitForSelector('.tree-item:has-text("' + newTitle + '")');
}

test('renaming a published folder online calls RenameDocument and shows no badge', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await renameViaMenu(page, 'Design', 'Art Direction');

    const calls = await h.calls(page, 'RenameDocument');
    assert.deepStrictEqual(calls.map((c) => c.args), [['f1', 'Art Direction']]);
    assert.strictEqual(await page.locator('.tree-item:has-text("Art Direction") .tree-badge').count(), 0);
    assert.strictEqual((await h.calls(page, 'UpdateDocument')).length, 0, 'rename must not rewrite content');
});

test('an offline folder rename shows a Renamed badge and a Publish rename action', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.evaluate(() => { window.__S.offline = true; });
    await renameViaMenu(page, 'Design', 'Art Direction');

    await page.waitForSelector('.toast:has-text("Publish the folder")');
    assert.strictEqual(await page.textContent('.tree-item:has-text("Art Direction") .tree-badge'), 'Renamed');

    await page.evaluate(() => { window.__S.offline = false; });
    await page.click('.tree-item:has-text("Art Direction")', { button: 'right' });
    const item = page.locator('#context-menu [data-action="publish"]');
    assert.ok(await item.isVisible());
    assert.strictEqual(await item.textContent(), 'Publish rename');
    await item.click();
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'PublishDocument' && c.args[0] === 'f1'));
    await page.waitForFunction(() => !document.querySelector('.tree-item .badge-modified'));
});

test('published pages and folders have no Publish action in the menu', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click('.tree-item:has-text("Q4 Roadmap")', { button: 'right' });
    assert.ok(!(await page.isVisible('#context-menu [data-action="publish"]')));
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 500);
    await page.click('.tree-item:has-text("Meeting Notes")', { button: 'right' });
    assert.ok(await page.isVisible('#context-menu [data-action="publish"]'));
});

test('renaming the open page keeps unsaved body edits', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 30 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' plus edits');

    await renameViaMenu(page, 'Meeting Notes', 'Standup Notes');
    assert.strictEqual(await page.inputValue('#doc-title'), 'Standup Notes');
    const doc = await page.evaluate(() => window.__S.docs.d2);
    assert.strictEqual(doc.title, 'Standup Notes');
    assert.match(doc.content, /plus edits/);
});
