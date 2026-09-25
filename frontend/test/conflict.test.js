'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const CONFLICT = 'ERR_CONFLICT: {"by":"Sam Rivera","at":"2026-09-24T15:12:00Z"}';

async function editAndPublish(page) {
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' Mine.');
    await page.evaluate((c) => {
        window.__S.fail.PublishDocument = c;
        window.__S.remoteContent = { d1: '# Q4 Roadmap\n\nSam wrote this.\n' };
    }, CONFLICT);
    await page.click('#btn-publish');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
}

test('conflict sheet names who changed the page and offers three choices', async () => {
    const page = await h.open(h.standardSeed());
    await editAndPublish(page);
    assert.strictEqual(await page.textContent('#confirm-title'), 'Sam Rivera changed “Q4 Roadmap” on Drive');
    assert.match(await page.textContent('#confirm-body'), /Publishing now would replace their text/);
    const labels = await page.$$eval('#confirm-actions button', (bs) => bs.map((b) => b.textContent));
    assert.deepStrictEqual(labels, ['Cancel', 'Load theirs', 'Keep both', 'Overwrite theirs']);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.match(await page.textContent('#editor .ProseMirror'), /Mine\./, 'cancel keeps my edits');
    assert.strictEqual((await h.calls(page, 'ForcePublishDocument')).length, 0);
});

test('Overwrite theirs force-publishes', async () => {
    const page = await h.open(h.standardSeed());
    await editAndPublish(page);
    await page.click('#conflict-overwrite');
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Published · up to date');
    assert.strictEqual((await h.calls(page, 'ForcePublishDocument')).length, 1);
    await page.waitForSelector('.toast:has-text("still in Version History")');
});

test('Load theirs asks again, then replaces the editor text', async () => {
    const page = await h.open(h.standardSeed());
    await editAndPublish(page);
    await page.click('#conflict-theirs');
    await page.waitForFunction(() => document.getElementById('confirm-title').textContent === 'Discard your unpublished edits?');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#editor .ProseMirror').textContent.includes('Sam wrote this.'));
    assert.doesNotMatch(await page.textContent('#editor .ProseMirror'), /Mine\./);
    assert.strictEqual(await page.textContent('#save-status'), 'Published · up to date');
});

test('Load theirs can be backed out of at the second step', async () => {
    const page = await h.open(h.standardSeed());
    await editAndPublish(page);
    await page.click('#conflict-theirs');
    await page.waitForFunction(() => document.getElementById('confirm-title').textContent === 'Discard your unpublished edits?');
    await page.click('#confirm-cancel');
    await page.waitForTimeout(100);
    assert.strictEqual((await h.calls(page, 'DiscardLocalChanges')).length, 0);
    assert.match(await page.textContent('#editor .ProseMirror'), /Mine\./);
});

test('Keep both creates "(my version)" and loads theirs into the original', async () => {
    const page = await h.open(h.standardSeed());
    await editAndPublish(page);
    await page.click('#conflict-both');
    await page.waitForSelector('.tree-item:has-text("Q4 Roadmap (my version)")');
    await page.waitForFunction(() => document.querySelector('#editor .ProseMirror').textContent.includes('Sam wrote this.'));
    const copy = await page.evaluate(() => Object.values(window.__S.docs).find((d) => d.title === 'Q4 Roadmap (my version)'));
    assert.match(copy.content, /Mine\./);
    await page.click('.toast:has-text("my version") .toast-action');
    await page.waitForFunction(() => document.getElementById('doc-title').value === 'Q4 Roadmap (my version)');
});
