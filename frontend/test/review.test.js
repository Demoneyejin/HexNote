'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

test('names with quotes cannot break out of HTML attributes', async () => {
    const evil = 'Wiki" onmouseover="window.__pwned=1" x="';
    const page = await h.open({
        workspaces: [{ id: 'ws-1', name: evil, driveFolderId: 'r', driveFolderUrl: 'u', access: 'owner' }],
        members: [{ id: 'm', workspaceId: 'ws-1', email: 'a@b.c', role: '<img src=x onerror="window.__pwned=2">', displayName: '' }],
    });
    await page.waitForSelector('.workspace-card');
    await page.hover('.workspace-card');
    assert.strictEqual(await page.getAttribute('.workspace-card', 'data-name'), evil);
    assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
    await page.click('.workspace-card');
    await page.waitForSelector('#view-editor:not(.hidden)');
    await page.click('#btn-share');
    await page.waitForSelector('.member-role');
    assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
    assert.match(await page.textContent('.member-role'), /<img/);
});

test('typing while a save is in flight keeps the page unsaved and saves again', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 1 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    // Make UpdateDocument slow so typing lands mid-save.
    await page.evaluate(() => {
        const orig = window.go.main.App.UpdateDocument;
        window.go.main.App.UpdateDocument = (...a) => new Promise((r) => setTimeout(() => r(orig(...a)), 600));
    });
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' first');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(150);
    await page.keyboard.type(' second');
    await page.waitForTimeout(700); // first save finishes
    assert.notStrictEqual(await page.textContent('#save-status'), 'Saved on this PC · not published', 'must not claim saved');
    await page.waitForFunction(() => /second/.test(window.__S.docs.d2.content), null, { timeout: 5000 });
});

test('a teammate update under unsaved typing keeps the typing and flags the conflict', async () => {
    const seed = h.standardSeed({ settings: { autoSaveDelaySecs: 30 } });
    seed.docs[0].driveModifiedAt = '2026-09-01T10:00:00Z';
    const page = await h.open(seed);
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' My typing.');
    await page.evaluate(() => {
        const d = window.__S.docs.d1;
        d.content = '# Q4 Roadmap\n\nSam rewrote this.\n';
        d.driveModifiedAt = '2026-09-02T10:00:00Z';
        window.runtime.EventsEmit('sync:docs-updated', ['d1']);
    });
    await page.waitForSelector('.toast:has-text("while you were typing")');
    assert.match(await page.textContent('#editor .ProseMirror'), /My typing\./);
    const keep = await h.calls(page, 'KeepEditBase');
    assert.deepStrictEqual(keep.map((c) => c.args), [['d1', '2026-09-01T10:00:00Z']]);
    const d = await page.evaluate(() => window.__S.docs.d1);
    assert.match(d.content, /My typing\./);
    assert.strictEqual(d.driveModifiedAt, '2026-09-01T10:00:00Z');
});
