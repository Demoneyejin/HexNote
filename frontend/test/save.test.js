'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

test('title-only edit reaches UpdateDocument via auto-save and updates the tree', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await h.clearCalls(page);

    await page.fill('#doc-title', 'Q4 Roadmap v2');
    await page.waitForTimeout(1600); // auto-save delay is 1 s in the seed

    const updates = await h.calls(page, 'UpdateDocument');
    assert.strictEqual(updates.length, 1, 'expected exactly one UpdateDocument call');
    assert.strictEqual(updates[0].args[1], 'Q4 Roadmap v2');
    await page.waitForSelector('.tree-item:has-text("Q4 Roadmap v2")');
    assert.deepStrictEqual(page.__errors, []);
});

test('title-only edit is saved by Ctrl+S', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 30 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await h.clearCalls(page);

    await page.fill('#doc-title', 'Renamed by shortcut');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);

    const updates = await h.calls(page, 'UpdateDocument');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].args[1], 'Renamed by shortcut');
});

test('opening a task-list + table page and pressing Ctrl+S does not re-save it', async () => {
    const content = '# Tasks\n\n- [ ] one\n- [x] two\n\n| A | B |\n| --- | --- |\n| 1 * 2 | x |\n\nAfter the table.\n';
    const page = await h.open({
        docs: [{ id: 'd1', title: 'Tasks', content, status: 'published', driveFileId: 'drv-d1' }],
    });
    await h.openWorkspace(page);
    await h.openPage(page, 'Tasks');
    await h.clearCalls(page);

    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1600);

    assert.strictEqual((await h.calls(page, 'UpdateDocument')).length, 0, 'unchanged page must not be re-saved');
    const badges = await page.locator('.tree-item:has-text("Tasks") .tree-badge').count();
    assert.strictEqual(badges, 0, 'no Modified badge');
});

test('a real body edit is saved once and keeps a trailing newline', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await h.clearCalls(page);

    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' Really.');
    await page.waitForTimeout(1600);

    const updates = await h.calls(page, 'UpdateDocument');
    assert.strictEqual(updates.length, 1);
    assert.match(updates[0].args[2], /Really\.\n$/);
});
