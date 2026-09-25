'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const active = (page) => page.evaluate(() => {
    const a = document.activeElement;
    return { id: a.id, cls: a.className, text: (a.textContent || '').trim().slice(0, 40), dataId: a.dataset && a.dataset.id };
});

test('every visible button has an accessible name', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    const unnamed = await page.$$eval('button', (bs) => bs
        .filter((b) => b.offsetParent !== null)
        .filter((b) => !(b.getAttribute('aria-label') || '').trim() && !(b.textContent || '').trim())
        .map((b) => b.outerHTML.slice(0, 80)));
    assert.deepStrictEqual(unnamed, []);
    // Icon-only buttons are named, not just titled.
    for (const id of ['btn-sync', 'btn-share', 'btn-settings', 'btn-new-page', 'btn-new-folder', 'btn-history', 'btn-delete-doc', 'btn-open-drive']) {
        assert.ok(await page.getAttribute('#' + id, 'aria-label'), id);
    }
});

test('the page tree works from the keyboard', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    assert.strictEqual(await page.getAttribute('#page-tree', 'role'), 'tree');
    const tabbable = await page.$$eval('#page-tree .tree-item', (els) => els.filter((e) => e.tabIndex === 0).length);
    assert.strictEqual(tabbable, 1, 'one tree item in the Tab order');

    await page.focus('#page-tree .tree-item');
    await page.keyboard.press('ArrowDown');
    assert.strictEqual((await active(page)).dataId, 'd2');
    await page.keyboard.press('ArrowDown');
    assert.strictEqual((await active(page)).dataId, 'f1');
    assert.strictEqual(await page.getAttribute('.tree-item[data-id="f1"]', 'aria-expanded'), 'false');
    await page.keyboard.press('ArrowRight'); // expand
    await page.waitForSelector('.tree-item[data-id="d3"]');
    assert.strictEqual((await active(page)).dataId, 'f1', 'focus survives the re-render');
    assert.strictEqual(await page.getAttribute('.tree-item[data-id="f1"]', 'aria-expanded'), 'true');
    await page.keyboard.press('ArrowRight'); // into first child
    assert.strictEqual((await active(page)).dataId, 'd3');
    await page.keyboard.press('ArrowLeft'); // to parent
    assert.strictEqual((await active(page)).dataId, 'f1');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('doc-title').value === 'Meeting Notes');
    assert.strictEqual(await page.getAttribute('.tree-item[data-id="d2"]', 'aria-selected'), 'true');
});

test('Shift+F10 opens the context menu with focus in it; Esc returns focus', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.focus('.tree-item[data-id="d1"]');
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('#context-menu:not(.hidden)');
    assert.strictEqual((await active(page)).text, 'New Page');
    await page.keyboard.press('ArrowDown');
    assert.strictEqual((await active(page)).text, 'New Folder');
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#context-menu'));
    assert.strictEqual((await active(page)).dataId, 'd1');
});

test('Delete key on a tree item asks before deleting', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.focus('.tree-item[data-id="d2"]');
    await page.keyboard.press('Delete');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    assert.match(await page.textContent('#confirm-title'), /Delete this draft/);
    await page.keyboard.press('Escape');
    assert.strictEqual((await h.calls(page, 'DeleteDocument')).length, 0);
});

test('dialogs take focus, trap Tab and give focus back', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.focus('#btn-settings');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#settings-modal:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('settings-modal').contains(document.activeElement));
    for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.getElementById('settings-modal').contains(document.activeElement)), 'Tab stays in the dialog');
    await page.keyboard.press('Escape');
    assert.strictEqual((await active(page)).id, 'btn-settings');
});

test('the workspace menu opens from the keyboard next to its button', async () => {
    const page = await h.open(h.standardSeed());
    await page.waitForSelector('.workspace-card');
    await page.focus('.ws-menu-btn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ws-context-menu:not(.hidden)');
    const pos = await page.$eval('#ws-context-menu', (m) => [parseInt(m.style.left, 10), parseInt(m.style.top, 10)]);
    assert.ok(pos[0] > 100 && pos[1] > 50, 'positioned at the button, got ' + pos);
    assert.strictEqual((await active(page)).text, 'Open');
});

test('removing a member asks first', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click('#btn-share');
    await page.click('.member-remove');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    assert.match(await page.textContent('#confirm-body'), /lose access/);
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'RemoveWorkspaceMember'));
});
