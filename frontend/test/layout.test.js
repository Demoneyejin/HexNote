'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const h = require('./harness');

after(h.closeBrowser);

function transparent(bg) {
    return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
}

test('delete icon button shows its icon on a transparent background', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await h.openPage(page, 'Q4 Roadmap');

    const info = await page.$eval('#btn-delete-doc', (el) => {
        const cs = getComputedStyle(el);
        const svg = el.querySelector('svg').getBoundingClientRect();
        return { bg: cs.backgroundColor, padding: cs.paddingLeft, svgW: svg.width, svgH: svg.height };
    });
    assert.ok(transparent(info.bg), 'background should be transparent, got ' + info.bg);
    assert.strictEqual(info.padding, '0px');
    assert.ok(info.svgW >= 14 && info.svgH >= 14, 'icon should be visible, got ' + JSON.stringify(info));
});

test('member remove buttons in the share modal render their x glyph', async () => {
    const page = await h.open(h.standardSeed());
    await h.openWorkspace(page);
    await page.click('#btn-share');
    await page.waitForSelector('.member-remove');

    const info = await page.$eval('.member-remove', (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { bg: cs.backgroundColor, padding: cs.paddingLeft, w: r.width, contentW: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
    });
    assert.ok(transparent(info.bg), 'background should be transparent, got ' + info.bg);
    assert.ok(info.contentW > 10, 'glyph needs room, got ' + JSON.stringify(info));
});
