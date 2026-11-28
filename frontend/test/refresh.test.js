'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const syncCount = async (page) => (await h.calls(page, 'TriggerSync')).length;

test('refreshes every syncIntervalSecs while a workspace is open', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 120 } }), { clock: true });
    await h.openWorkspace(page);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'TriggerSync'));
    assert.strictEqual(await syncCount(page), 1, 'one refresh on open');
    await page.clock.fastForward(121000);
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.name === 'TriggerSync').length === 2);
    await page.clock.fastForward(120000);
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.name === 'TriggerSync').length === 3);
});

test('interval 0 turns the timer off', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 0 } }), { clock: true });
    await h.openWorkspace(page);
    await page.clock.fastForward(600000);
    await page.waitForTimeout(100);
    assert.strictEqual(await syncCount(page), 1);
});

test('no timer refresh outside the editor', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 60 } }), { clock: true });
    await page.waitForSelector('#view-workspaces:not(.hidden)');
    await page.clock.fastForward(300000);
    await page.waitForTimeout(100);
    assert.strictEqual(await syncCount(page), 0);
});

test('window focus refreshes, at most once a minute', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 0 } }), { clock: true });
    await h.openWorkspace(page);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'TriggerSync'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(100);
    assert.strictEqual(await syncCount(page), 1, 'throttled right after the open refresh');
    await page.clock.fastForward(61000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.name === 'TriggerSync').length === 2);
});

test('a quiet refresh with no changes shows no toast; changes show a count', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 60 } }), { clock: true });
    await h.openWorkspace(page);
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.name === 'TriggerSync').length === 2);
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('.toast').count(), 0);

    await page.evaluate(() => {
        window.__S.docs.d3.content = 'New colours from Sam.\n';
        window.__S.syncResult = ['d3', 'd1'];
    });
    await page.clock.fastForward(61000);
    await page.waitForSelector('.toast:has-text("2 pages updated from Drive")');
});

test('the open published page reloads with a teammate’s change', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.evaluate(() => {
        window.__S.docs.d1.content = '# Q4 Roadmap\n\nShip v0.3 instead.\n';
        window.__S.syncResult = ['d1'];
    });
    await page.click('#btn-sync');
    await page.waitForFunction(() => document.querySelector('#editor .ProseMirror').textContent.includes('Ship v0.3 instead.'));
    assert.strictEqual(await page.textContent('#save-status'), 'Published · up to date');
    await page.waitForTimeout(1500);
    assert.strictEqual((await h.calls(page, 'UpdateDocument')).length, 0, 'reloading must not re-save');
});

test('unsaved typing is saved before a refresh and never overwritten', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 30 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' My edit.');
    await h.clearCalls(page);
    await page.evaluate(() => {
        window.__S.syncMutations = (S) => { if (S.docs.d1.status === 'published') S.docs.d1.content = 'theirs\n'; };
        window.__S.syncResult = ['d1'];
    });
    await page.click('#btn-sync');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'TriggerSync'));
    await page.waitForTimeout(200);

    const names = (await h.calls(page)).map((c) => c.name);
    assert.ok(names.indexOf('UpdateDocument') >= 0 && names.indexOf('UpdateDocument') < names.indexOf('TriggerSync'), 'save happens before the refresh: ' + names.join(','));
    assert.match(await page.textContent('#editor .ProseMirror'), /My edit\./);
    assert.strictEqual(await page.textContent('#save-status'), 'Published · edits not published');
});

test('manual refresh with nothing new says Already up to date', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'TriggerSync'));
    await page.click('#btn-sync');
    await page.waitForSelector('.toast:has-text("Already up to date")');
});

test('offline auto-refresh is quiet and says so in the status bar', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 60 } }), { clock: true });
    await h.openWorkspace(page);
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'TriggerSync'));
    await page.evaluate(() => { window.__S.fail.TriggerSync = 'ERR_OFFLINE: refresh from Drive: dial tcp: i/o timeout'; });
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => document.getElementById('sync-status-text').textContent.startsWith('Offline'));
    assert.strictEqual(await page.locator('.toast').count(), 0);
});

test('settings expose the refresh interval', async () => {
    const page = await h.open(h.standardSeed({ settings: { syncIntervalSecs: 120 } }));
    await h.openWorkspace(page);
    await page.click('#btn-settings');
    assert.strictEqual(await page.inputValue('#setting-sync-interval'), '120');
    await page.fill('#setting-sync-interval', '300');
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'UpdateSettings'));
    const call = (await h.calls(page, 'UpdateSettings'))[0];
    assert.strictEqual(call.args[0], 300);
});
