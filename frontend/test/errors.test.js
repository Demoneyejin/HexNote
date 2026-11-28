'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

async function lastToast(page) {
    const t = page.locator('.toast').last();
    await t.waitFor();
    return {
        text: await t.locator('.toast-text').textContent(),
        action: (await t.locator('.toast-action').count()) ? await t.locator('.toast-action').textContent() : null,
    };
}

test('offline publish explains and offers Retry, which retries', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.evaluate(() => { window.__S.fail.PublishDocument = 'ERR_OFFLINE: create Drive file: dial tcp: lookup www.googleapis.com: no such host'; });
    await page.click('#btn-publish');
    const t = await lastToast(page);
    assert.match(t.text, /^Couldn’t publish\. Google Drive can’t be reached/);
    assert.doesNotMatch(t.text, /dial tcp|ERR_/);
    assert.strictEqual(t.action, 'Retry');
    await page.click('.toast-action');
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.name === 'PublishDocument').length === 2);
});

test('forbidden offers to open the workspace folder in Drive', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.evaluate(() => { window.__S.fail.PublishDocument = 'ERR_FORBIDDEN: create Drive file: googleapi: Error 403: insufficientFilePermissions'; });
    await page.click('#btn-publish');
    const t = await lastToast(page);
    assert.match(t.text, /permission/);
    assert.strictEqual(t.action, 'Open folder in Drive');
    await page.click('.toast-action');
    const opened = await page.evaluate(() => window.__S.opened);
    assert.deepStrictEqual(opened, ['https://drive.google.com/drive/folders/drive-root-1']);
});

test('auth error offers Sign in again', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.evaluate(() => { window.__S.fail.TriggerSync = 'ERR_AUTH: refresh from Drive: Google sign-in expired: oauth2: "invalid_grant"'; });
    await page.click('#btn-sync');
    const t = await lastToast(page);
    assert.strictEqual(t.text, 'Couldn’t refresh from Drive. Your Google sign-in expired.');
    await page.click('.toast-action');
    await page.waitForSelector('#view-signin:not(.hidden)');
});

test('unknown errors show a short generic message and log the detail', async () => {
    const page = await h.open(h.standardSeed());
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
    await h.openWorkspace(page);
    await page.evaluate(() => { window.__S.fail.TriggerSync = 'refresh from Drive: list files: googleapi: Error 400: Invalid Value, invalid'; });
    await page.click('#btn-sync');
    const t = await lastToast(page);
    assert.strictEqual(t.text, 'Couldn’t refresh from Drive. Something went wrong. Try again in a moment.');
    assert.ok(logs.some((l) => l.includes('Invalid Value')), 'detail should be in the console');
});

test('ERR_INVALID text is shown as is (credentials JSON)', async () => {
    const page = await h.open({ auth: { hasCredentials: false, isSignedIn: false } });
    await page.waitForSelector('#view-credentials:not(.hidden)');
    await page.evaluate(() => { window.__S.fail.ImportCredentials = 'ERR_INVALID: This isn\'t a Desktop app client.'; });
    await page.fill('#credentials-json', '{"web":{}}');
    await page.click('#btn-save-credentials');
    await page.waitForSelector('#credentials-error:not(.hidden)');
    assert.strictEqual(await page.textContent('#credentials-error'), 'This isn\'t a Desktop app client.');
});

test('cancelling the export folder picker shows nothing', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.evaluate(() => { window.__S.fail.ExportWorkspace = 'no folder selected'; });
    await page.click('#btn-settings');
    await page.click('#btn-export-workspace');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('.toast-error, .toast-warning').count(), 0);
});
