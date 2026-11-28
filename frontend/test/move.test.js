'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

const item = (t) => '.tree-item:has-text("' + t + '")';

async function order(page) {
    return page.$$eval('#page-tree > .tree-node > .tree-item .tree-label', (els) => els.map((e) => e.textContent));
}

async function drag(page, from, to, where) {
    const box = await page.locator(item(to)).first().boundingBox();
    const y = where === 'before' ? 3 : (where === 'after' ? box.height - 3 : box.height / 2);
    await page.dragAndDrop(item(from), item(to), { targetPosition: { x: 40, y } });
}

test('drag a page into a folder moves it there', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await drag(page, 'Meeting Notes', 'Design', 'into');
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'MoveDocumentTo'));
    const call = (await h.calls(page, 'MoveDocumentTo'))[0];
    assert.deepStrictEqual(call.args, ['d2', 'f1', '']);
    await page.waitForSelector('.tree-children ' + item('Meeting Notes'));
});

test('drag above and below reorders siblings', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    assert.deepStrictEqual(await order(page), ['Q4 Roadmap', 'Meeting Notes', 'Design']);

    await drag(page, 'Design', 'Q4 Roadmap', 'before');
    await page.waitForFunction(() => document.querySelector('#page-tree .tree-label').textContent === 'Design');
    assert.deepStrictEqual(await order(page), ['Design', 'Q4 Roadmap', 'Meeting Notes']);

    await drag(page, 'Design', 'Meeting Notes', 'after');
    await page.waitForFunction(() => [...document.querySelectorAll('#page-tree > .tree-node > .tree-item .tree-label')].pop().textContent === 'Design');
    const last = (await h.calls(page, 'MoveDocumentTo')).pop();
    assert.deepStrictEqual(last.args, ['f1', '', '']);
});

test('a folder cannot be dropped into itself or its children', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click(item('Design')); // expand
    await page.waitForSelector(item('Art Bible'));
    await drag(page, 'Design', 'Art Bible', 'before');
    await page.waitForTimeout(200);
    assert.strictEqual((await h.calls(page, 'MoveDocumentTo')).length, 0);
});

test('Move to… picker moves via keyboard-reachable buttons', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click(item('Q4 Roadmap'), { button: 'right' });
    await page.click('#context-menu [data-action="move"]');
    await page.waitForSelector('#move-modal:not(.hidden)');
    assert.match(await page.textContent('#move-hint'), /moves on Google Drive too/);
    const opts = await page.$$eval('.move-option', (bs) => bs.map((b) => b.textContent + (b.disabled ? ' [x]' : '')));
    assert.deepStrictEqual(opts, ['Top level of the workspace (current) [x]', 'Design']);

    await page.keyboard.press('Enter'); // first enabled option has focus
    await page.waitForFunction(() => window.__S.calls.some((c) => c.name === 'MoveDocumentTo'));
    assert.deepStrictEqual((await h.calls(page, 'MoveDocumentTo'))[0].args, ['d1', 'f1', '']);
    assert.ok(await page.isHidden('#move-modal'));
});

test('Move to… excludes the folder itself; Esc closes', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click(item('Design'), { button: 'right' });
    await page.click('#context-menu [data-action="move"]');
    const opts = await page.$$eval('.move-option', (bs) => bs.map((b) => b.textContent));
    assert.deepStrictEqual(opts, ['Top level of the workspace (current)']);
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#move-modal'));
});

test('a draft says it moves on this PC only', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click(item('Meeting Notes'), { button: 'right' });
    await page.click('#context-menu [data-action="move"]');
    assert.match(await page.textContent('#move-hint'), /on this PC only/);
});
