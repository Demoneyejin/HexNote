'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

// Fails the test if any native dialog appears.
function forbidNativeDialogs(page) {
    page.__native = [];
    page.on('dialog', async (d) => { page.__native.push(d.type() + ': ' + d.message()); await d.dismiss(); });
}

test('delete uses the in-app sheet; Esc cancels, the danger button deletes', async () => {
    const page = await h.open(h.standardSeed());
    forbidNativeDialogs(page);
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');

    await page.click('#btn-delete-doc');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    assert.match(await page.textContent('#confirm-title'), /move its Drive file to trash/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'confirm-cancel', 'Cancel is focused');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirm-sheet.hidden', { state: 'attached' });
    assert.strictEqual((await h.calls(page, 'DeleteDocument')).length, 0);

    await page.click('#btn-delete-doc');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'DeleteDocument'));
    assert.deepStrictEqual(page.__native, []);
});

test('Enter on the sheet does not confirm a destructive action', async () => {
    const page = await h.open(h.standardSeed());
    forbidNativeDialogs(page);
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#btn-delete-doc');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    await page.keyboard.press('Enter'); // activates the focused Cancel
    await page.waitForTimeout(200);
    assert.strictEqual((await h.calls(page, 'DeleteDocument')).length, 0);
    assert.ok(await page.isHidden('#confirm-sheet'));
});

test('double-click renames a page inline; Enter commits', async () => {
    const page = await h.open(h.standardSeed());
    forbidNativeDialogs(page);
    await h.openWorkspace(page);
    await page.dblclick('.tree-item:has-text("Meeting Notes") .tree-label');
    const input = page.locator('.tree-rename-input');
    await input.waitFor();
    assert.strictEqual(await input.inputValue(), 'Meeting Notes');
    await input.fill('Standup');
    await input.press('Enter');
    await page.waitForSelector('.tree-item:has-text("Standup")');
    assert.deepStrictEqual((await h.calls(page, 'RenameDocument')).map((c) => c.args), [['d2', 'Standup']]);
    assert.deepStrictEqual(page.__native, []);
});

test('F2 renames the selected page; Esc cancels', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.focus('.tree-item:has-text("Q4 Roadmap")').catch(() => {});
    await page.dispatchEvent('.tree-item:has-text("Q4 Roadmap")', 'keydown', { key: 'F2', bubbles: true });
    const input = page.locator('.tree-rename-input');
    await input.waitFor();
    await input.fill('Nope');
    await input.press('Escape');
    await page.waitForSelector('.tree-item:has-text("Q4 Roadmap")');
    assert.strictEqual((await h.calls(page, 'RenameDocument')).length, 0);
});

test('context-menu Rename on a folder edits inline', async () => {
    const page = await h.open(h.standardSeed());
    forbidNativeDialogs(page);
    await h.openWorkspace(page);
    await page.click('.tree-item:has-text("Design")', { button: 'right' });
    await page.click('#context-menu [data-action="rename"]');
    const input = page.locator('.tree-rename-input');
    await input.waitFor();
    await input.fill('Art');
    await input.press('Enter');
    await page.waitForSelector('.tree-item:has-text("Art")');
    assert.deepStrictEqual(page.__native, []);
});

test('workspace rename and delete use inline edit and the sheet', async () => {
    const page = await h.open(h.standardSeed());
    forbidNativeDialogs(page);
    await page.waitForSelector('.workspace-card');
    await page.click('.ws-menu-btn');
    await page.click('#ws-context-menu [data-action="ws-rename"]');
    const input = page.locator('.ws-rename-input');
    await input.waitFor();
    await input.fill('Studio Handbook');
    await input.press('Enter');
    await page.waitForSelector('.workspace-card:has-text("Studio Handbook")');

    await page.click('.ws-menu-btn');
    await page.click('#ws-context-menu [data-action="ws-delete"]');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    assert.match(await page.textContent('#confirm-body'), /stay on Drive/);
    assert.match(await page.textContent('#confirm-body'), /never published are deleted/);
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'DeleteWorkspace'));
    assert.deepStrictEqual(page.__native, []);
});

test('restore version asks through the sheet', async () => {
    const page = await h.open(h.standardSeed({
        revisions: { d1: [{ revisionId: 'r1', modifiedTime: '2026-09-01T10:00:00Z', size: 20, lastModifyingUser: 'Sam', content: '# Old\n' }] },
    }));
    forbidNativeDialogs(page);
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#btn-history');
    await page.click('.history-item');
    await page.click('#btn-restore-version');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'RestoreVersion'));
    assert.deepStrictEqual(page.__native, []);
});
