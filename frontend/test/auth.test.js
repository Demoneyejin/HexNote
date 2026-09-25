'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const EXPIRED = 'Your Google sign-in expired. Sign in again to continue. Pages saved on this PC are safe.';

test('auth:expired saves the open draft and shows the sign-in view with a notice', async () => {
    const page = await h.open(h.standardSeed({ settings: { autoSaveDelaySecs: 30 } }));
    await h.openWorkspace(page);
    await h.openPage(page, 'Meeting Notes');
    await page.click('#editor .ProseMirror p');
    await page.keyboard.press('End');
    await page.keyboard.type(' unsaved words');
    await h.clearCalls(page);

    await page.evaluate(() => window.runtime.EventsEmit('auth:expired'));
    await page.waitForSelector('#view-signin:not(.hidden)');

    assert.strictEqual(await page.textContent('#signin-notice'), EXPIRED);
    assert.ok(await page.isVisible('#signin-notice'));
    const updates = await h.calls(page, 'UpdateDocument');
    assert.strictEqual(updates.length, 1, 'the open draft must be saved locally');
    assert.match(updates[0].args[2], /unsaved words/);
});

test('booting with an expired sign-in shows the notice', async () => {
    const page = await h.open({ auth: { isSignedIn: false, sessionExpired: true } });
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.strictEqual(await page.textContent('#signin-notice'), EXPIRED);
});

test('a normal sign-out shows no expiry notice', async () => {
    const page = await h.open(h.standardSeed());
    await page.waitForSelector('#view-workspaces:not(.hidden)');
    await page.click('#btn-signout');
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.ok(!(await page.isVisible('#signin-notice')));
});

test('settings has an Account group with email, sign out and change credentials', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click('#btn-settings');
    await page.waitForSelector('#settings-modal:not(.hidden)');
    assert.strictEqual(await page.textContent('#settings-account-email'), 'alex@example.com');

    await page.click('#btn-settings-credentials');
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.ok(await page.isVisible('#btn-credentials-back'), 'Back link when changing credentials');
    await page.click('#btn-credentials-back');
    await page.waitForSelector('#view-workspaces:not(.hidden)');

    await h.openWorkspace(page);
    await page.click('#btn-settings');
    await page.click('#btn-settings-signout');
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.ok((await h.calls(page, 'SignOut')).length === 1);
    assert.ok(await page.isHidden('#settings-modal'));
});

test('first-run credentials screen has no Back link', async () => {
    const page = await h.open({ auth: { hasCredentials: false, isSignedIn: false } });
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.ok(!(await page.isVisible('#btn-credentials-back')));
});
