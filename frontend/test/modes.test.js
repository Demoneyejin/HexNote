'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const BUILTIN_SIGNED_OUT = { auth: { hasCredentials: true, isSignedIn: false, mode: 'builtin', bundledAvailable: true }, workspaces: [] };

test('a build with a bundled client opens on "Sign in with Google" with an own-credentials link', async () => {
    const page = await h.open(BUILTIN_SIGNED_OUT);
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.strictEqual(await page.textContent('#signin-heading'), 'Sign in with Google');
    assert.match(await page.textContent('#signin-desc'), /Google Drive folder you choose/);
    assert.strictEqual(await page.textContent('#btn-custom-credentials'), 'Use your own Google Cloud credentials instead');
    assert.ok(!(await page.isVisible('#btn-use-bundled')));

    await page.click('#btn-custom-credentials');
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.strictEqual(await page.textContent('#credentials-heading'), 'Use your own Google Cloud credentials');
    assert.ok(await page.isVisible('#credentials-own-intro'));
    assert.ok(await page.isVisible('#btn-credentials-back'));
});

test('a plain build (no bundled client) keeps today’s first screen', async () => {
    const page = await h.open({ auth: { hasCredentials: false, isSignedIn: false, mode: '', bundledAvailable: false } });
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.strictEqual(await page.textContent('#credentials-heading'), 'Welcome! One-time Setup');
    assert.ok(!(await page.isVisible('#credentials-own-intro')));
    assert.ok(!(await page.isVisible('#btn-use-bundled-from-creds')));
});

// The built-in sign-in has full Drive access, so nothing is held back:
// choosing an existing folder and joining a shared one both work.
for (const mode of ['builtin', 'own-key']) {
    test(mode + ' sign-in: pick a Drive folder or join a shared workspace', async () => {
        const page = await h.open({ auth: { mode: mode, bundledAvailable: true }, workspaces: [] });
        await page.waitForSelector('#view-path-choice:not(.hidden)');
        assert.strictEqual(await page.textContent('#path-join-desc'), 'Open a workspace someone shared with you');
        await page.click('#btn-path-join');
        await page.waitForSelector('#view-join:not(.hidden)');
        await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'SearchSharedFolders'));
        await page.click('#btn-back-to-path-choice');
        await page.click('#btn-path-create');
        await page.waitForSelector('#view-onboarding:not(.hidden)');
        await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'ListDriveFolders'));
    });
}

test('built-in sign-in: Settings names the sign-in and offers own credentials', async () => {
    const page = await h.open(h.standardSeed({ auth: { mode: 'builtin', bundledAvailable: true } }));
    await h.openWorkspace(page);
    await page.click('#btn-settings');
    assert.match(await page.textContent('#settings-account-mode'), /^Signed in with HexNote’s Google sign-in/);
    assert.strictEqual(await page.textContent('#btn-settings-credentials'), 'Use your own Google Cloud credentials');
});

test('own credentials with a bundled client offers switching back to HexNote’s sign-in', async () => {
    const page = await h.open({ auth: { hasCredentials: true, isSignedIn: false, mode: 'own-key', bundledAvailable: true } });
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.ok(await page.isVisible('#btn-use-bundled'));
    await page.click('#btn-use-bundled');
    await page.waitForFunction(() => document.getElementById('signin-heading').textContent === 'Sign in with Google');
    assert.strictEqual((await h.calls(page, 'UseBundledCredentials')).length, 1);
});
