'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const SOLO_SIGNED_OUT = { auth: { hasCredentials: true, isSignedIn: false, mode: 'solo', bundledAvailable: true }, workspaces: [] };

test('a build with a bundled client opens on "Sign in with Google" with a Team mode link', async () => {
    const page = await h.open(SOLO_SIGNED_OUT);
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.strictEqual(await page.textContent('#signin-heading'), 'Sign in with Google');
    assert.match(await page.textContent('#signin-desc'), /can only see files it created/);
    assert.strictEqual(await page.textContent('#btn-custom-credentials'), 'Use your team’s credentials instead');
    assert.ok(!(await page.isVisible('#btn-use-bundled')));

    await page.click('#btn-custom-credentials');
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.strictEqual(await page.textContent('#credentials-heading'), 'Use your team’s credentials');
    assert.ok(await page.isVisible('#credentials-team-intro'));
    assert.ok(await page.isVisible('#btn-credentials-back'));
});

test('a plain build (no bundled client) keeps today’s first screen', async () => {
    const page = await h.open({ auth: { hasCredentials: false, isSignedIn: false, mode: '', bundledAvailable: false } });
    await page.waitForSelector('#view-credentials:not(.hidden)');
    assert.strictEqual(await page.textContent('#credentials-heading'), 'Welcome! One-time Setup');
    assert.ok(!(await page.isVisible('#credentials-team-intro')));
    assert.ok(!(await page.isVisible('#btn-use-bundled-from-creds')));
});

test('Solo mode: new workspace is "Name your workspace" and HexNote creates the folder', async () => {
    const page = await h.open({ auth: { mode: 'solo', bundledAvailable: true }, workspaces: [] });
    await page.waitForSelector('#view-path-choice:not(.hidden)');
    await page.click('#btn-path-create');
    await page.waitForSelector('#view-solo-create:not(.hidden)');
    assert.strictEqual((await h.calls(page, 'ListDriveFolders')).length, 0, 'no folder picker under drive.file');
    await page.fill('#solo-workspace-name', 'Game Jam');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-editor:not(.hidden)');
    assert.deepStrictEqual((await h.calls(page, 'CreateSoloWorkspace')).map((c) => c.args), [['Game Jam']]);
    assert.strictEqual(await page.textContent('#workspace-title'), 'Game Jam');
});

test('Solo mode: Join explains Team mode instead of searching shared folders', async () => {
    const page = await h.open({ auth: { mode: 'solo', bundledAvailable: true }, workspaces: [] });
    await page.waitForSelector('#view-path-choice:not(.hidden)');
    assert.match(await page.textContent('#path-join-desc'), /Needs Team mode/);
    await page.click('#btn-path-join');
    await page.waitForSelector('#confirm-sheet:not(.hidden)');
    assert.match(await page.textContent('#confirm-title'), /needs Team mode/);
    assert.strictEqual((await h.calls(page, 'SearchSharedFolders')).length, 0);
    await page.click('#confirm-ok');
    await page.waitForSelector('#view-credentials:not(.hidden)');
});

test('Solo mode: Share stays, with a note that collaborators need Team mode; Settings names the mode', async () => {
    const page = await h.open(h.standardSeed({ auth: { mode: 'solo', bundledAvailable: true } }));
    await h.openWorkspace(page);
    await page.click('#btn-share');
    assert.ok(await page.isVisible('#share-solo-note'));
    assert.ok(await page.isVisible('#btn-share-invite'));
    await page.keyboard.press('Escape');
    await page.click('#btn-settings');
    assert.match(await page.textContent('#settings-account-mode'), /^Solo mode/);
    assert.strictEqual(await page.textContent('#btn-settings-credentials'), 'Switch to Team mode');
});

test('Team mode keeps every current feature', async () => {
    const page = await h.open({ auth: { mode: 'team', bundledAvailable: true }, workspaces: [] });
    await page.waitForSelector('#view-path-choice:not(.hidden)');
    await page.click('#btn-path-join');
    await page.waitForSelector('#view-join:not(.hidden)');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'SearchSharedFolders'));
    await page.click('#btn-back-to-path-choice');
    await page.click('#btn-path-create');
    await page.waitForSelector('#view-onboarding:not(.hidden)');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'ListDriveFolders'));
});

test('Team mode with a bundled client offers switching back to Solo', async () => {
    const page = await h.open({ auth: { hasCredentials: true, isSignedIn: false, mode: 'team', bundledAvailable: true } });
    await page.waitForSelector('#view-signin:not(.hidden)');
    assert.ok(await page.isVisible('#btn-use-bundled'));
    await page.click('#btn-use-bundled');
    await page.waitForFunction(() => document.getElementById('signin-heading').textContent === 'Sign in with Google');
    assert.strictEqual((await h.calls(page, 'UseBundledCredentials')).length, 1);
});
