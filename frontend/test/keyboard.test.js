'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

test('every toolbar button has a name, and tooltips show shortcuts', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    const btns = await page.$$eval('.toolbar-btn', (bs) => bs.map((b) => ({ name: b.getAttribute('aria-label'), title: b.title })));
    for (const b of btns) assert.ok(b.name && b.title.startsWith(b.name), JSON.stringify(b));
    const byName = Object.fromEntries(btns.map((b) => [b.name, b.title]));
    assert.strictEqual(byName.Bold, 'Bold (Ctrl+B)');
    assert.strictEqual(byName['Heading 2'], 'Heading 2 (Ctrl+Alt+2)');
    assert.strictEqual(byName['Task list'], 'Task list (Ctrl+Shift+9)');
    assert.strictEqual(byName.Undo, 'Undo (Ctrl+Z)');
    assert.ok(byName.Link && byName.Redo, 'Link and Redo exist');
});

test('undo and redo buttons work and disable when there is nothing to do', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    assert.ok(await page.isDisabled('.toolbar-btn[aria-label="Undo"]'));
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await page.click('.toolbar-btn[aria-label="Undo"]');
    await page.waitForFunction(() => !document.querySelector('#editor .ProseMirror').textContent.includes('typed'));
    await page.click('.toolbar-btn[aria-label="Redo"]');
    await page.waitForFunction(() => document.querySelector('#editor .ProseMirror').textContent.includes('typed'));
});

test('Link button adds a link to the selection via the sheet, and removes it', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.click('.toolbar-btn[aria-label="Link"]');
    await page.waitForSelector('#confirm-sheet:not(.hidden) #confirm-input');
    await page.keyboard.type('example.com/docs');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#editor .ProseMirror a[href="https://example.com/docs"]');

    // Ctrl+click opens it in the browser
    await page.click('#editor .ProseMirror a', { modifiers: ['Control'] });
    assert.deepStrictEqual(await page.evaluate(() => window.__S.opened), ['https://example.com/docs']);

    await page.click('#editor .ProseMirror a');
    await page.click('.toolbar-btn[aria-label="Link"]');
    assert.strictEqual(await page.inputValue('#confirm-input'), 'https://example.com/docs');
    await page.click('#link-remove');
    await page.waitForFunction(() => !document.querySelector('#editor .ProseMirror a'));
});

test('javascript: links are refused', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#editor .ProseMirror p');
    await page.click('.toolbar-btn[aria-label="Link"]');
    await page.fill('#confirm-input', 'javascript:alert(1)');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Enter a web address")');
    assert.strictEqual(await page.locator('#editor .ProseMirror a').count(), 0);
});

test('Ctrl+N creates a page, Ctrl+K focuses search, Ctrl+Shift+P publishes', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');

    await page.keyboard.press('Control+k');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'search-input');

    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('Control+Shift+P');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'PublishDocument' && c.args[0] === 'd2'));

    await page.keyboard.press('Control+n');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'CreateDocument'));
    await page.waitForFunction(() => document.getElementById('doc-title').value === 'New Page');
});

test('Esc closes context menus, search results and modals', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);

    await page.click('.tree-item:has-text("Q4 Roadmap")', { button: 'right' });
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#context-menu'));

    for (const [open, modal] of [['#btn-settings', '#settings-modal'], ['#btn-share', '#sharing-modal']]) {
        await page.click(open);
        await page.waitForSelector(modal + ':not(.hidden)');
        await page.keyboard.press('Escape');
        assert.ok(await page.isHidden(modal), modal + ' should close');
    }

    await page.fill('#search-input', 'roadmap');
    await page.waitForSelector('#search-results:not(.hidden)');
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#search-results'));
});

test('Ctrl+Z right after opening a page does not empty it or replay the previous page', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 30 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT-A');
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.textContent('#editor .ProseMirror'), 'Q4 RoadmapShip v0.2 by December.');
    // Editing still works after the history reset.
    await page.keyboard.type('!');
    assert.match(await page.textContent('#save-status'), /Unsaved changes/);
});
