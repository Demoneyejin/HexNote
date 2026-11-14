// Mermaid diagram blocks for the HexNote editor.
//
// A diagram is an ordinary fenced code block whose language is "mermaid", so the
// stored markdown stays portable (GitHub, GitLab and Obsidian render the same
// fence). This file only changes how such a block is *displayed*: it shows the
// rendered SVG, and reveals the source while the cursor is inside the block.
//
// Why a raw ProseMirror node view instead of a TipTap extension: the vendored
// tiptap-bundle.js exposes finished extensions only (no Node/Extension/Plugin
// classes), and ProseMirror's `nodeViews` view prop needs none of them.
(function () {
    'use strict';

    // Vendored copy of dist/mermaid.min.js from the npm package mermaid@12.3.0 (MIT).
    // ~5.5 MB, so it is loaded on first use only.
    var MERMAID_SRC = '/vendor/mermaid.min.js';
    var RENDER_DELAY_MS = 300;
    var LANGUAGE = 'mermaid';
    var TEMPLATE = 'flowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Do it]\n    B -->|No| D[Skip]';

    var loadPromise = null;
    var renderChain = Promise.resolve(); // one render at a time: theme is global mermaid state
    var renderSeq = 0;
    var liveViews = [];

    function isDark() {
        var manual = document.documentElement.getAttribute('data-theme');
        if (manual === 'dark') return true;
        if (manual === 'light') return false;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function loadMermaid() {
        if (window.mermaid) return Promise.resolve(window.mermaid);
        if (loadPromise) return loadPromise;
        loadPromise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = MERMAID_SRC;
            script.onload = function () {
                if (window.mermaid) resolve(window.mermaid);
                else reject(new Error('Mermaid loaded but did not register itself'));
            };
            script.onerror = function () {
                loadPromise = null; // allow a retry on the next render
                reject(new Error('Could not load the Mermaid library'));
            };
            document.head.appendChild(script);
        });
        return loadPromise;
    }

    // Returns a promise for the SVG markup of `source`.
    function renderDiagram(source) {
        var run = function () {
            return loadMermaid().then(function (mermaid) {
                mermaid.initialize({
                    startOnLoad: false,
                    // Published pages come from shared Drive folders, so diagram text is
                    // untrusted input: 'strict' sanitises labels and disables click handlers.
                    securityLevel: 'strict',
                    // Errors are shown in our own preview box, not as an injected "bomb" SVG.
                    suppressErrorRendering: true,
                    theme: isDark() ? 'dark' : 'default',
                });
                var id = 'hexnote-mermaid-' + (++renderSeq);
                return mermaid.render(id, source).then(
                    function (result) { return result.svg; },
                    function (err) {
                        // mermaid can leave its temporary measuring container behind on failure
                        var stray = document.getElementById('d' + id) || document.getElementById(id);
                        if (stray) stray.remove();
                        throw err;
                    }
                );
            });
        };
        var result = renderChain.then(run, run);
        renderChain = result.catch(function () {});
        return result;
    }

    function createMermaidView(editor, node, getPos) {
        var dom = document.createElement('div');
        dom.className = 'mermaid-block';

        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.className = 'language-' + LANGUAGE;
        pre.appendChild(code);

        var preview = document.createElement('div');
        preview.className = 'mermaid-preview';
        preview.contentEditable = 'false';
        preview.title = 'Click to edit diagram source';

        dom.appendChild(pre);
        dom.appendChild(preview);

        var timer = null;
        var destroyed = false;
        var renderedSource = null;

        function showMessage(text, isError) {
            preview.textContent = text;
            preview.classList.toggle('is-error', !!isError);
            preview.classList.add('is-message');
        }

        function render() {
            timer = null;
            var source = node.textContent.trim();
            if (source === renderedSource) return;
            if (!source) {
                renderedSource = source;
                showMessage('Empty diagram — click to add Mermaid source', false);
                return;
            }
            renderDiagram(source).then(
                function (svg) {
                    if (destroyed || node.textContent.trim() !== source) return; // stale result
                    renderedSource = source;
                    preview.classList.remove('is-error', 'is-message');
                    preview.innerHTML = svg;
                },
                function (err) {
                    if (destroyed || node.textContent.trim() !== source) return;
                    renderedSource = source;
                    showMessage((err && (err.message || err.str)) || String(err), true);
                }
            );
        }

        function scheduleRender(immediate) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(render, immediate ? 0 : RENDER_DELAY_MS);
        }

        // Source is visible only while the selection is inside this block.
        function syncEditing() {
            if (destroyed) return;
            var pos = getPos();
            if (typeof pos !== 'number') return;
            var sel = editor.state.selection;
            var inside = sel.from > pos && sel.to < pos + node.nodeSize;
            dom.classList.toggle('is-editing', inside);
        }

        preview.addEventListener('mousedown', function (event) {
            event.preventDefault();
            var pos = getPos();
            if (typeof pos !== 'number') return;
            editor.chain().focus().setTextSelection(pos + 1).run();
        });

        editor.on('transaction', syncEditing);
        setTimeout(syncEditing, 0); // editor.state is not yet current while the view is being built
        scheduleRender(true);

        var view = {
            dom: dom,
            contentDOM: code,
            update: function (updated) {
                // Returning false makes ProseMirror rebuild the view (e.g. as a plain code block).
                if (updated.type !== node.type || updated.attrs.language !== LANGUAGE) return false;
                node = updated;
                scheduleRender(false);
                return true;
            },
            // Let our own handler deal with clicks on the preview.
            stopEvent: function (event) { return preview.contains(event.target); },
            // Preview and class changes are ours; only edits inside the source are document changes.
            ignoreMutation: function (mutation) { return !code.contains(mutation.target); },
            destroy: function () {
                destroyed = true;
                if (timer) clearTimeout(timer);
                editor.off('transaction', syncEditing);
                var i = liveViews.indexOf(view);
                if (i !== -1) liveViews.splice(i, 1);
            },
            rerender: function () { renderedSource = null; scheduleRender(true); },
        };
        liveViews.push(view);
        return view;
    }

    function rerenderAll() {
        liveViews.forEach(function (view) { view.rerender(); });
    }

    var themeWatchInstalled = false;
    function watchTheme() {
        if (themeWatchInstalled) return;
        themeWatchInstalled = true;
        new MutationObserver(rerenderAll)
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderAll);
    }

    // The collapsed source of a diagram is skipped by the browser's own vertical caret
    // movement, so Up/Down from a neighbouring text block step into it explicitly.
    function enterAdjacentDiagram(editor, view, event) {
        var down = event.key === 'ArrowDown';
        if (!down && event.key !== 'ArrowUp') return false;
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        var sel = view.state.selection;
        if (!sel.empty || sel.$from.depth === 0 || !view.endOfTextblock(down ? 'down' : 'up')) return false;
        var edge = down ? sel.$from.after() : sel.$from.before();
        var $edge = view.state.doc.resolve(edge);
        var neighbour = down ? $edge.nodeAfter : $edge.nodeBefore;
        if (!neighbour || neighbour.type.name !== 'codeBlock' || neighbour.attrs.language !== LANGUAGE) return false;
        editor.commands.setTextSelection(down ? edge + 1 : edge - 1);
        return true;
    }

    // Registers the diagram view on an existing TipTap editor.
    function attach(editor) {
        var existing = editor.view.props.nodeViews || {};
        var existingKeyDown = editor.view.props.handleKeyDown;
        editor.view.setProps({
            handleKeyDown: function (view, event) {
                if (existingKeyDown && existingKeyDown(view, event)) return true;
                return enterAdjacentDiagram(editor, view, event);
            },
            nodeViews: Object.assign({}, existing, {
                codeBlock: function (node, view, getPos) {
                    // undefined => ProseMirror falls back to the default <pre><code> rendering
                    if (node.attrs.language !== LANGUAGE) return undefined;
                    return createMermaidView(editor, node, getPos);
                },
            }),
        });
        watchTheme();
    }

    function insert(editor) {
        editor.chain().focus().insertContent({
            type: 'codeBlock',
            attrs: { language: LANGUAGE },
            content: [{ type: 'text', text: TEMPLATE }],
        }).run();
    }

    function isActive(editor) {
        return editor.isActive('codeBlock', { language: LANGUAGE });
    }

    window.HexMermaid = { attach: attach, insert: insert, isActive: isActive };
})();
