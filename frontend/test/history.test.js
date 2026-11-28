'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const REVS = {
    d1: [
        { revisionId: 'r2', modifiedTime: '2026-09-20T10:00:00Z', size: 40, lastModifyingUser: 'Sam', content: '# Q4 Roadmap\n\nShip v0.2 by December.\n' },
        { revisionId: 'r1', modifiedTime: '2026-09-01T10:00:00Z', size: 3000, lastModifyingUser: 'Alex', content: '# Old plan\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
    ],
};

test('preview renders the revision as a page, not raw markdown', async () => {
    const page = await h.open(h.standardSeed({ revisions: REVS }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#btn-history');
    const sizes = await page.$$eval('.history-item-size', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(sizes, ['40 bytes', '3 KB']);

    await page.click('.history-item[data-rev="r1"]');
    await page.waitForSelector('#history-preview-content h1');
    assert.strictEqual(await page.textContent('#history-preview-content h1'), 'Old plan');
    assert.ok(await page.locator('#history-preview-content table').count() === 1, 'table rendered');
    assert.ok(await page.locator('#history-preview-content ul[data-type="taskList"]').count() === 1, 'task list rendered');
    assert.doesNotMatch(await page.textContent('#history-preview-content'), /\| --- \|/);
    assert.strictEqual(await page.getAttribute('#history-preview-content .ProseMirror', 'contenteditable'), 'false');
});

test('restoring over unpublished edits keeps them as a separate page', async () => {
    const seed = h.standardSeed({ revisions: REVS });
    seed.docs[0].status = 'draft'; // Q4 Roadmap has unpublished edits
    seed.docs[0].content = '# Q4 Roadmap\n\nMy unpublished plan.\n';
    const page = await h.open(seed);
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#btn-history');
    await page.click('.history-item[data-rev="r1"]');
    await page.waitForSelector('#history-preview-content h1');
    await page.click('#btn-restore-version');
    assert.match(await page.textContent('#confirm-body'), /unpublished edits are first saved as a separate draft page/);
    await page.click('#confirm-ok');

    await page.waitForSelector('.toast:has-text("Your previous text is in")');
    assert.strictEqual(await page.textContent('#editor .ProseMirror h1'), 'Old plan');
    await page.waitForSelector('.tree-item:has-text("Q4 Roadmap (before restore)")');
    await page.click('.toast:has-text("Your previous text") .toast-action');
    await page.waitForFunction(() => document.querySelector('#editor .ProseMirror').textContent.includes('My unpublished plan.'));
});

test('restoring an up-to-date page makes no backup page', async () => {
    const page = await h.open(h.standardSeed({ revisions: REVS }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#btn-history');
    await page.click('.history-item[data-rev="r1"]');
    await page.waitForSelector('#history-preview-content h1');
    await page.click('#btn-restore-version');
    assert.match(await page.textContent('#confirm-body'), /stays in this list as the newest version/);
    await page.click('#confirm-ok');
    await page.waitForSelector('.toast:has-text("Version restored")');
    assert.strictEqual(await page.locator('.tree-item:has-text("before restore")').count(), 0);
    assert.strictEqual(await page.textContent('#save-status'), 'Published · edits not published');
});
