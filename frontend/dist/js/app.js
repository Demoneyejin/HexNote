// HexNote - Main Application Logic
// Uses window.go.main.App.* for Wails backend bindings

(function () {
    'use strict';

    // === State ===
    var editor = null;
    var currentDocId = null;
    var saveTimeout = null;
    var tree = [];
    var expandedFolders = new Set();
    var currentFolderPath = [{ id: 'root', name: 'My Drive' }];
    var activeWorkspace = null;
    var autoSaveDelay = 2000;
    var selectedRevisionId = null;
    var refreshToolbar = function () {}; // set by buildEditorToolbar
    var lastKnownContent = '';  // serializer output for the last content loaded/saved — prevents auto-save from re-dirtying unchanged docs
    var lastKnownTitle = '';    // title as last loaded/saved — a title-only edit must still reach the backend
    var currentDocMeta = null;  // { status, driveFileId } of the open page, for the status line
    var saveState = 'saved';    // 'saved' | 'unsaved' | 'saving' | 'error'
    var draftHintDismissed = true; // loaded from UI state at startup
    var syncIntervalSecs = 120;  // auto-refresh period; 0 = off
    var refreshTimer = null;
    var lastRefreshAt = 0;
    var refreshInFlight = null;  // promise of the running refresh, if any

    // === View Management ===
    var ALL_VIEWS = ['view-credentials', 'view-signin', 'view-path-choice', 'view-workspaces', 'view-onboarding', 'view-join', 'view-editor'];

    function showView(viewId) {
        ALL_VIEWS.forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            if (id !== viewId) {
                el.classList.add('hidden');
                el.classList.remove('view-enter');
            } else {
                el.classList.remove('hidden');
                // Trigger enter animation on next frame
                el.classList.remove('view-enter');
                requestAnimationFrame(function () { el.classList.add('view-enter'); });
            }
        });
    }

    // === Toast Notification System ===
    // showToast shows a transient message. action, if given, adds a button:
    // { label: 'Retry', run: function () { ... } }.
    function showToast(message, type, durationMs, action) {
        type = type || 'info';
        durationMs = durationMs || (action ? 8000 : 4000);
        var container = document.getElementById('toast-container');
        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        var text = document.createElement('span');
        text.className = 'toast-text';
        text.textContent = message;
        toast.appendChild(text);
        function dismiss() {
            toast.classList.remove('toast-visible');
            toast.addEventListener('transitionend', function () { toast.remove(); });
            setTimeout(function () { toast.remove(); }, 400);
        }
        if (action) {
            var btn = document.createElement('button');
            btn.className = 'toast-action';
            btn.textContent = action.label;
            btn.addEventListener('click', function () { dismiss(); action.run(); });
            toast.appendChild(btn);
        }
        container.appendChild(toast);
        requestAnimationFrame(function () { toast.classList.add('toast-visible'); });
        setTimeout(dismiss, durationMs);
    }

    // === Errors ===
    // The Go side prefixes errors with a stable code (see the Errors section
    // in app.go). describeError turns one into a sentence and, where it
    // helps, an action. The raw detail goes to the console.
    function errorMessage(e) {
        return (e && e.message) || String(e == null ? '' : e);
    }

    function errorCode(e) {
        var m = /^(ERR_[A-Z]+):/.exec(errorMessage(e));
        return m ? m[1] : null;
    }

    // what: short verb phrase for the failed action ("publish", "refresh").
    // retry: optional function offered as a Retry action when offline.
    function describeError(e, what, retry) {
        var code = errorCode(e);
        var lead = what ? 'Couldn\u2019t ' + what + '. ' : '';
        switch (code) {
            case 'ERR_OFFLINE':
                return {
                    code: code,
                    text: lead + 'Google Drive can\u2019t be reached. Check your connection; your work is saved on this PC.',
                    action: retry ? { label: 'Retry', run: retry } : null,
                };
            case 'ERR_AUTH':
                return {
                    code: code,
                    text: lead + 'Your Google sign-in expired.',
                    action: { label: 'Sign in again', run: async function () { await leaveEditor(); showSigninView(''); } },
                };
            case 'ERR_FORBIDDEN':
                return {
                    code: code,
                    text: lead + 'You don\u2019t have permission to change this on Google Drive. Ask the folder owner for edit access.',
                    action: activeWorkspace && activeWorkspace.driveFolderUrl
                        ? { label: 'Open folder in Drive', run: openWorkspaceInDrive }
                        : null,
                };
            case 'ERR_NOTFOUND':
                return {
                    code: code,
                    text: lead + 'It no longer exists on Google Drive, or it isn\u2019t shared with you.',
                    action: currentView() === 'view-editor' ? { label: 'Refresh', run: function () { triggerSync(); } } : null,
                };
            case 'ERR_CONFLICT':
                return { code: code, text: lead + 'Someone else changed this page on Drive.', action: null };
            case 'ERR_INVALID':
                return { code: code, text: errorMessage(e).replace(/^ERR_INVALID:\s*/, ''), action: null };
        }
        return { code: null, text: lead + 'Something went wrong. Try again in a moment.', action: retry ? { label: 'Retry', run: retry } : null };
    }

    // showError reports a failed action in a toast.
    function showError(what, e, retry) {
        console.error('[' + (what || 'error') + ']', errorMessage(e));
        var d = describeError(e, what, retry);
        // An expired sign-in already switched to the sign-in view.
        if (d.code === 'ERR_AUTH' && currentView() === 'view-signin') return;
        showToast(d.text, d.code === 'ERR_OFFLINE' ? 'warning' : 'error', null, d.action);
    }

    function currentView() {
        for (var i = 0; i < ALL_VIEWS.length; i++) {
            var el = document.getElementById(ALL_VIEWS[i]);
            if (el && !el.classList.contains('hidden')) return ALL_VIEWS[i];
        }
        return null;
    }

    function openWorkspaceInDrive() {
        if (activeWorkspace && activeWorkspace.driveFolderUrl && window.runtime) {
            window.runtime.BrowserOpenURL(activeWorkspace.driveFolderUrl);
        }
    }

    // === Keyboard shortcuts ===
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

    // shortcutLabel turns 'Mod+Shift+P' into 'Ctrl+Shift+P' (or ⌘⇧P on a Mac).
    function shortcutLabel(keys) {
        if (!isMac) return keys.replace('Mod', 'Ctrl');
        return keys.replace('Mod+', '\u2318').replace('Shift+', '\u21E7').replace('Alt+', '\u2325');
    }

    // === Confirmation sheet ===
    // askChoice shows an in-app sheet and resolves with the chosen value, or
    // null when dismissed (Esc, Cancel, or a click on the backdrop).
    //   opts.title, opts.body: text (never HTML)
    //   opts.choices: [{ label, value, kind: 'danger'|'primary'|'secondary', id }]
    //   opts.cancelLabel: label of the Cancel button (default 'Cancel')
    // The Cancel button is focused first, so Enter never confirms a destructive
    // action by accident.
    var sheetResolve = null;

    function askChoice(opts) {
        var sheet = document.getElementById('confirm-sheet');
        var actions = document.getElementById('confirm-actions');
        if (sheetResolve) closeSheet(null);
        document.getElementById('confirm-title').textContent = opts.title || '';
        document.getElementById('confirm-body').textContent = opts.body || '';
        actions.innerHTML = '';

        // Optional single-line text field (askText).
        var field = document.getElementById('confirm-field');
        var input = document.getElementById('confirm-input');
        field.classList.toggle('hidden', !opts.input);
        if (opts.input) {
            document.getElementById('confirm-input-label').textContent = opts.input.label || '';
            input.value = opts.input.value || '';
            input.placeholder = opts.input.placeholder || '';
        }

        var cancel = document.createElement('button');
        cancel.id = 'confirm-cancel';
        cancel.className = 'btn-secondary';
        cancel.textContent = opts.cancelLabel || 'Cancel';
        cancel.addEventListener('click', function () { closeSheet(null); });
        actions.appendChild(cancel);

        (opts.choices || []).forEach(function (c) {
            var b = document.createElement('button');
            if (c.id) b.id = c.id;
            b.className = c.kind === 'danger' ? 'btn-danger' : (c.kind === 'secondary' ? 'btn-secondary' : 'btn-primary');
            b.textContent = c.label;
            b.dataset.value = c.value;
            b.addEventListener('click', function () { closeSheet(c.value); });
            actions.appendChild(b);
        });

        sheetReturnFocus = document.activeElement;
        sheet.classList.remove('hidden');
        if (opts.input) { input.focus(); input.select(); } else cancel.focus();
        return new Promise(function (resolve) { sheetResolve = resolve; });
    }

    var sheetReturnFocus = null;

    function closeSheet(value) {
        document.getElementById('confirm-sheet').classList.add('hidden');
        var resolve = sheetResolve;
        sheetResolve = null;
        if (sheetReturnFocus && sheetReturnFocus.focus && document.body.contains(sheetReturnFocus)) {
            try { sheetReturnFocus.focus(); } catch (e) { /* ignore */ }
        }
        sheetReturnFocus = null;
        if (resolve) resolve(value);
    }

    // askConfirm is a yes/no sheet: resolves true only when confirmed.
    async function askConfirm(title, body, confirmLabel, danger) {
        var v = await askChoice({
            title: title,
            body: body,
            choices: [{ id: 'confirm-ok', label: confirmLabel || 'OK', value: 'ok', kind: danger ? 'danger' : 'primary' }],
        });
        return v === 'ok';
    }

    // askText shows the sheet with a text field. Resolves with
    // { choice, text } or null when dismissed. Enter in the field picks
    // the first 'primary' choice.
    async function askText(opts) {
        var choice = await askChoice(Object.assign({}, opts, { input: { label: opts.label, value: opts.value, placeholder: opts.placeholder } }));
        if (choice === null) return null;
        return { choice: choice, text: document.getElementById('confirm-input').value };
    }

    function bindSheetEvents() {
        var sheet = document.getElementById('confirm-sheet');
        document.getElementById('confirm-input').addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var primary = document.querySelector('#confirm-actions .btn-primary');
            if (primary) primary.click();
        });
        sheet.addEventListener('mousedown', function (e) {
            if (e.target === sheet) closeSheet(null);
        });
        // Capture phase so Esc closes the sheet before anything else sees it.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && sheetResolve) {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeSheet(null);
            }
        }, true);
    }

    // === Theme ===
    function applyTheme(theme) {
        if (theme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        updateEditorDarkMode();
    }

    function updateEditorDarkMode() {
        var isDark = false;
        var manualTheme = document.documentElement.getAttribute('data-theme');
        if (manualTheme === 'dark') {
            isDark = true;
        } else if (manualTheme === 'light') {
            isDark = false;
        } else {
            // System default
            isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        document.body.classList.toggle('dark-editor', isDark);
    }

    // Listen for system theme changes
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateEditorDarkMode);
    }

    // === Init ===
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForWails);
    } else {
        waitForWails();
    }

    function waitForWails() {
        if (window.go && window.go.main && window.go.main.App) {
            init();
        } else {
            var attempts = 0;
            var interval = setInterval(function () {
                attempts++;
                if (window.go && window.go.main && window.go.main.App) {
                    clearInterval(interval);
                    init();
                } else if (attempts > 200) {
                    clearInterval(interval);
                }
            }, 50);
        }
    }

    async function init() {
        bindGlobalEvents();

        // Load settings and apply theme
        try {
            var settings = await window.go.main.App.GetSettings();
            if (settings) {
                applyTheme(settings.theme);
                if (settings.autoSaveDelaySecs > 0) {
                    autoSaveDelay = settings.autoSaveDelaySecs * 1000;
                }
                if (typeof settings.syncIntervalSecs === 'number') syncIntervalSecs = settings.syncIntervalSecs;
            }
        } catch (e) { /* ignore — settings not critical for boot */ }
        scheduleAutoRefresh();
        // Coming back to the window is when a teammate's changes matter most.
        window.addEventListener('focus', function () { autoRefresh('focus'); });

        try {
            draftHintDismissed = (await window.go.main.App.GetUIState('draft-hint-dismissed')) === '1';
        } catch (e) { draftHintDismissed = false; }

        updateEditorDarkMode();
        await routeToCorrectView();
    }

    async function routeToCorrectView() {
        try {
            var status = await window.go.main.App.GetAuthStatus();
            authStatus = status;

            if (!status.hasCredentials) {
                showCredentialsView(false);
                return;
            }
            if (!status.isSignedIn) {
                showSigninView(status.sessionExpired ? SESSION_EXPIRED_TEXT : '');
                return;
            }

            // Signed in — show user email everywhere
            var email = status.userEmail || '';
            document.getElementById('settings-account-email').textContent = email || 'Signed in';
            document.getElementById('user-email-display').textContent = email;
            document.querySelectorAll('.user-badge').forEach(function (el) {
                el.textContent = email;
                el.title = email;
            });

            // Check workspaces
            var workspaces = await window.go.main.App.GetWorkspaces();
            if (!workspaces || workspaces.length === 0) {
                // No workspaces — show path choice (Create vs Join)
                showView('view-path-choice');
            } else {
                showWorkspacesView(workspaces);
            }
        } catch (e) {
            console.error('Route error:', e);
            showView('view-credentials');
        }
    }

    // === Credentials View ===
    function bindCredentialsEvents() {
        document.getElementById('btn-save-credentials').addEventListener('click', async function () {
            var json = document.getElementById('credentials-json').value.trim();
            var errEl = document.getElementById('credentials-error');
            errEl.classList.add('hidden');

            if (!json) {
                errEl.textContent = 'Please paste your credentials JSON.';
                errEl.classList.remove('hidden');
                return;
            }
            try {
                await window.go.main.App.ImportCredentials(json);
                document.getElementById('credentials-json').value = '';
                // Same client as before keeps the sign-in; a new one needs a sign-in.
                await routeToCorrectView();
            } catch (e) {
                errEl.textContent = describeError(e).text;
                errEl.classList.remove('hidden');
            }
        });

        document.getElementById('btn-credentials-back').addEventListener('click', routeToCorrectView);

        document.getElementById('link-gcp').addEventListener('click', function (e) {
            e.preventDefault();
            if (window.runtime) window.runtime.BrowserOpenURL('https://console.cloud.google.com/apis/credentials');
        });
    }

    var SESSION_EXPIRED_TEXT = 'Your Google sign-in expired. Sign in again to continue. Pages saved on this PC are safe.';
    var authStatus = null;

    // showCredentialsView opens the paste-your-credentials screen. canGoBack
    // shows a Back link when credentials already exist (changing them).
    function showCredentialsView(canGoBack) {
        document.getElementById('credentials-error').classList.add('hidden');
        document.getElementById('btn-credentials-back').classList.toggle('hidden', !canGoBack);
        showView('view-credentials');
    }

    // showSigninView opens the sign-in screen, optionally with a notice
    // explaining why (for example an expired sign-in).
    function showSigninView(notice) {
        var noticeEl = document.getElementById('signin-notice');
        noticeEl.textContent = notice || '';
        noticeEl.classList.toggle('hidden', !notice);
        document.getElementById('signin-waiting').classList.add('hidden');
        document.getElementById('signin-error').classList.add('hidden');
        showView('view-signin');
    }

    // leaveEditor saves the open page and closes it and any modal, before
    // switching to a screen outside the workspace (sign-in, credentials).
    async function leaveEditor() {
        if (currentDocId) {
            try { await saveNow(); } catch (e) { /* saving is local; keep going */ }
        }
        currentDocId = null;
        document.querySelectorAll('.modal-overlay').forEach(function (m) { m.classList.add('hidden'); });
    }

    // === Sign In View ===
    function bindSigninEvents() {
        document.getElementById('btn-google-signin').addEventListener('click', async function () {
            var waitEl = document.getElementById('signin-waiting');
            var errEl = document.getElementById('signin-error');
            waitEl.classList.remove('hidden');
            errEl.classList.add('hidden');

            try {
                await window.go.main.App.StartOAuthFlow();
            } catch (e) {
                errEl.textContent = describeError(e, 'start the sign-in').text;
                errEl.classList.remove('hidden');
                waitEl.classList.add('hidden');
            }
        });

        // Advanced: let power users provide their own OAuth credentials
        document.getElementById('btn-custom-credentials').addEventListener('click', function () {
            showCredentialsView(true);
        });

        // Listen for auth completion from Wails event
        if (window.runtime) {
            window.runtime.EventsOn('auth:complete', async function () {
                await window.go.main.App.OnAuthComplete();
                await routeToCorrectView();
            });
            // Google rejected the saved sign-in (revoked, or expired after 7 days
            // while the consent screen is in Testing). Keep local work, then ask
            // the user to sign in again.
            window.runtime.EventsOn('auth:expired', async function () {
                await leaveEditor();
                showSigninView(SESSION_EXPIRED_TEXT);
            });
            window.runtime.EventsOn('auth:error', function (msg) {
                var errEl = document.getElementById('signin-error');
                errEl.textContent = 'Auth error: ' + msg;
                errEl.classList.remove('hidden');
                document.getElementById('signin-waiting').classList.add('hidden');
            });
            // Listen for backend notifications
            window.runtime.EventsOn('notification', function (data) {
                showToast(data.message, data.level);
            });
            window.runtime.EventsOn('settings:changed', function (s) {
                if (s && s.theme) applyTheme(s.theme);
                if (s && s.autoSaveDelaySecs > 0) autoSaveDelay = s.autoSaveDelaySecs * 1000;
                if (s && typeof s.syncIntervalSecs === 'number') { syncIntervalSecs = s.syncIntervalSecs; scheduleAutoRefresh(); }
            });

            // Refresh tree when sync pulls new published pages
            // The open page is reloaded only when it has no local edits: a draft
            // is never overwritten (the backend does not touch drafts either).
            window.runtime.EventsOn('sync:docs-updated', async function (ids) {
                await loadTree();
                if (currentDocId && (ids || []).indexOf(currentDocId) >= 0 && isOpenPageClean()) {
                    await reloadCurrentDoc();
                }
            });

            // A teammate deleted pages on Drive: they are gone here too, except
            // pages with unpublished local edits, which were kept as drafts.
            window.runtime.EventsOn('sync:docs-removed', async function (data) {
                var removed = (data && data.removed) || [];
                var detached = (data && data.detached) || [];
                if (currentDocId && removed.indexOf(currentDocId) >= 0) {
                    currentDocId = null;
                    window.__hexnoteHasUnsaved = false;
                    document.getElementById('editor-container').classList.add('hidden');
                }
                await loadTree();
                updateEmptyState();
                if (removed.length) {
                    showToast(removed.length === 1 ? 'A page was deleted by a teammate.' : removed.length + ' pages were deleted by a teammate.', 'info');
                }
                if (detached.length) {
                    showToast((detached.length === 1 ? 'A page you edited was' : detached.length + ' pages you edited were') + ' deleted on Drive. Your edits are kept here as drafts.', 'warning', 8000);
                }
            });
        }
    }

    // === Workspaces View ===
    function showWorkspacesView(workspaces) {
        showView('view-workspaces');
        var grid = document.getElementById('workspace-grid');
        var noWs = document.getElementById('no-workspaces');

        if (!workspaces || workspaces.length === 0) {
            grid.innerHTML = '';
            noWs.classList.remove('hidden');
            return;
        }

        noWs.classList.add('hidden');
        knownWorkspaces = workspaces;
        grid.innerHTML = workspaces.map(function (ws) {
            var synced = ws.lastSyncedAt ? 'Refreshed from Drive ' + new Date(ws.lastSyncedAt).toLocaleString() : 'Not refreshed yet';
            var tag = '';
            if (ws.access === 'owner') tag = '<span class="ws-tag ws-tag-owner" title="You own this Google Drive folder">Owner</span>';
            else if (ws.access === 'writer') tag = '<span class="ws-tag" title="Shared with you; you can edit">Shared \u00b7 Editor</span>';
            else if (ws.access === 'reader' || ws.access === 'commenter') tag = '<span class="ws-tag" title="Shared with you; you can view">Shared \u00b7 Viewer</span>';
            return '<div class="workspace-card" tabindex="0" role="button" data-id="' + escapeHtml(ws.id) + '" data-name="' + escapeHtml(ws.name) + '" aria-label="Open workspace ' + escapeHtml(ws.name) + '">' +
                '<div class="workspace-card-body">' +
                '<h3>' + escapeHtml(ws.name) + '</h3>' +
                '<p class="workspace-meta">' + synced + '</p>' +
                '</div>' +
                '<div class="workspace-card-footer">' + tag +
                (ws.driveFolderUrl ? '<button class="ws-drive-link btn-link" data-url="' + escapeHtml(ws.driveFolderUrl) + '">Open in Drive</button>' : '') +
                '</div>' +
                '<button class="ws-menu-btn" data-id="' + escapeHtml(ws.id) + '" data-name="' + escapeHtml(ws.name) + '" title="Options" aria-label="Options for ' + escapeHtml(ws.name) + '">\u22EE</button>' +
                '</div>';
        }).join('');

        grid.querySelectorAll('.ws-drive-link').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (window.runtime) window.runtime.BrowserOpenURL(btn.dataset.url);
            });
        });
        grid.querySelectorAll('.workspace-card').forEach(function (card) {
            card.addEventListener('keydown', function (e) {
                if (e.target !== card) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkspace(card.dataset.id); }
            });
        });

        // Click card body → open workspace
        grid.querySelectorAll('.workspace-card').forEach(function (card) {
            card.addEventListener('click', function (e) {
                // Don't open if they clicked the menu button
                if (e.target.closest('.ws-menu-btn')) return;
                openWorkspace(card.dataset.id);
            });
        });

        // Three-dot menu button
        grid.querySelectorAll('.ws-menu-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                showWsContextMenu(e, btn.dataset.id, btn.dataset.name);
            });
        });

        // Right-click on card → context menu
        grid.querySelectorAll('.workspace-card').forEach(function (card) {
            card.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                showWsContextMenu(e, card.dataset.id, card.dataset.name);
            });
        });

        // Right-click on empty grid space → new workspace
        grid.addEventListener('contextmenu', function (e) {
            if (e.target.closest('.workspace-card')) return;
            e.preventDefault();
            showWsContextMenu(e, null, null);
        });
    }

    // startWorkspaceRename edits a workspace card's name in place.
    function startWorkspaceRename(wsId) {
        var card = document.querySelector('.workspace-card[data-id="' + cssEscape(wsId) + '"]');
        if (!card) return;
        var h3 = card.querySelector('h3');
        var oldName = card.dataset.name;
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'input-text ws-rename-input';
        input.value = oldName;
        input.setAttribute('aria-label', 'Workspace name');
        h3.replaceWith(input);
        input.focus();
        input.select();

        var done = false;
        async function finish(commit) {
            if (done) return;
            done = true;
            var name = input.value.trim();
            if (commit && name && name !== oldName) {
                try { await window.go.main.App.RenameWorkspace(wsId, name); } catch (e) { showError('rename the workspace', e); }
            }
            showWorkspacesView(await window.go.main.App.GetWorkspaces());
        }
        input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });
        input.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    var knownWorkspaces = [];
    var wsContextTargetId = null;
    var wsContextTargetName = null;

    function showWsContextMenu(e, wsId, wsName) {
        wsContextTargetId = wsId;
        wsContextTargetName = wsName;
        var menu = document.getElementById('ws-context-menu');
        // A keyboard "click" on the ⋮ button has no pointer position.
        var fromKeyboard = e.detail === 0 && e.currentTarget && e.currentTarget.getBoundingClientRect;
        if (fromKeyboard) e = anchorEvent(e.currentTarget);
        menuReturnFocus = fromKeyboard ? document.activeElement : null;
        menu.style.top = e.clientY + 'px';
        menu.style.left = e.clientX + 'px';
        menu.classList.remove('hidden');

        var isCard = !!wsId;
        menu.querySelector('[data-action="ws-open"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-drive"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-rename"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-permissions"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-delete"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-new"]').style.display = isCard ? 'none' : '';
        var sep = menu.querySelector('hr');
        if (sep) sep.style.display = isCard ? '' : 'none';
        keepMenuOnScreen(menu);
        if (fromKeyboard) focusMenu(menu);
    }

    // keepMenuOnScreen nudges a menu that would overflow the window.
    function keepMenuOnScreen(menu) {
        var r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) menu.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
        if (r.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
    }

    async function onWsContextAction(e) {
        var action = e.target.closest('button').dataset.action;
        document.getElementById('ws-context-menu').classList.add('hidden');
        restoreMenuFocus();
        switch (action) {
            case 'ws-open':
                if (wsContextTargetId) openWorkspace(wsContextTargetId);
                break;
            case 'ws-drive':
                var target = knownWorkspaces.filter(function (w) { return w.id === wsContextTargetId; })[0];
                if (target && target.driveFolderUrl && window.runtime) window.runtime.BrowserOpenURL(target.driveFolderUrl);
                break;
            case 'ws-rename':
                if (!wsContextTargetId) break;
                startWorkspaceRename(wsContextTargetId);
                break;
            case 'ws-delete':
                if (!wsContextTargetId) break;
                var delId = wsContextTargetId;
                var ok = await askConfirm(
                    'Remove "' + wsContextTargetName + '" from this PC?',
                    'The Google Drive folder and its published pages stay on Drive, and you can add the workspace again later. Drafts that were never published are deleted.',
                    'Remove from this PC', true);
                if (ok) {
                    await window.go.main.App.DeleteWorkspace(delId);
                    var ws2 = await window.go.main.App.GetWorkspaces();
                    showWorkspacesView(ws2);
                }
                break;
            case 'ws-new':
                document.getElementById('btn-add-workspace').click();
                break;
            case 'ws-permissions':
                if (!wsContextTargetId) break;
                // Open the workspace first, then show the sharing modal
                await openWorkspace(wsContextTargetId);
                document.getElementById('sharing-modal').classList.remove('hidden');
                loadMembers();
                break;
        }
        wsContextTargetId = null;
        wsContextTargetName = null;
    }

    async function doSignOut() {
        await leaveEditor();
        await window.go.main.App.SignOut();
        showSigninView('');
    }

    function bindWorkspacesEvents() {
        document.getElementById('btn-add-workspace').addEventListener('click', function () {
            showView('view-path-choice');
        });

        document.getElementById('btn-signout').addEventListener('click', doSignOut);

        // Workspace context menu actions
        document.querySelectorAll('#ws-context-menu button').forEach(function (btn) {
            btn.addEventListener('click', onWsContextAction);
        });
        // Close workspace context menu on click elsewhere
        document.addEventListener('click', function () {
            document.getElementById('ws-context-menu').classList.add('hidden');
        });
    }

    async function openWorkspace(wsId) {
        try {
            activeWorkspace = await window.go.main.App.SwitchWorkspace(wsId);
            showView('view-editor');
            document.getElementById('workspace-title').textContent = activeWorkspace.name;
            initEditorIfNeeded();
            currentDocId = null;
            document.getElementById('editor-container').classList.add('hidden');
            document.getElementById('empty-state').classList.remove('hidden');
            await loadTree();
            // Pull published pages from Drive
            triggerSync({ quiet: true });
            // Refresh the member cache quietly so workspace cards can show
            // whether this folder is yours or shared with you.
            window.go.main.App.GetWorkspaceMembers(activeWorkspace.id).catch(function () { /* optional */ });
        } catch (e) {
            showError('open the workspace', e);
        }
    }

    // === Folder Picker / Onboarding ===
    // === Path Choice (Create vs Join) ===
    function bindPathChoiceEvents() {
        document.getElementById('btn-path-create').addEventListener('click', function () {
            currentFolderPath = [{ id: 'root', name: 'My Drive' }];
            showView('view-onboarding');
            loadFolders('root');
        });

        document.getElementById('btn-path-join').addEventListener('click', function () {
            showView('view-join');
            loadSharedFolders('');
        });

        document.getElementById('btn-signout-pathchoice').addEventListener('click', doSignOut);
    }

    // === Onboarding (Create Workspace) ===
    function bindOnboardingEvents() {
        document.getElementById('btn-create-drive-folder').addEventListener('click', async function () {
            var name = document.getElementById('new-folder-name').value.trim();
            if (!name) return;
            var parentId = currentFolderPath[currentFolderPath.length - 1].id;
            try {
                await window.go.main.App.CreateDriveFolder(name, parentId);
                document.getElementById('new-folder-name').value = '';
                loadFolders(parentId);
                showToast('Folder created', 'success');
            } catch (e) {
                showError('create the folder', e);
            }
        });

        document.getElementById('btn-select-folder').addEventListener('click', async function () {
            var name = document.getElementById('workspace-name').value.trim();
            var current = currentFolderPath[currentFolderPath.length - 1];
            if (!name) name = current.name;
            try {
                await window.go.main.App.CreateWorkspace(name, current.id);
                var workspaces = await window.go.main.App.GetWorkspaces();
                showToast('Workspace created!', 'success');
                showWorkspacesView(workspaces);
            } catch (e) {
                showError('create the workspace', e);
            }
        });

        document.getElementById('btn-back-to-workspaces').addEventListener('click', async function () {
            var workspaces = await window.go.main.App.GetWorkspaces();
            if (!workspaces || workspaces.length === 0) {
                showView('view-path-choice');
            } else {
                showWorkspacesView(workspaces);
            }
        });
    }

    // === Join Shared Workspace ===
    var selectedSharedFolder = null;

    function bindJoinEvents() {
        var searchTimeout;
        document.getElementById('shared-search-input').addEventListener('input', function () {
            clearTimeout(searchTimeout);
            var query = this.value.trim();
            searchTimeout = setTimeout(function () { loadSharedFolders(query); }, 300);
        });

        // Paste folder link
        document.getElementById('btn-resolve-link').addEventListener('click', async function () {
            var link = document.getElementById('paste-folder-link').value.trim();
            var resultEl = document.getElementById('paste-link-result');
            if (!link) return;
            resultEl.textContent = 'Looking up folder...';
            resultEl.classList.remove('hidden');
            try {
                var folder = await window.go.main.App.ResolveFolderLink(link);
                selectedSharedFolder = { id: folder.id, name: folder.name };
                resultEl.textContent = 'Found: ' + folder.name;
                resultEl.className = 'status-text status-success';
                document.getElementById('join-workspace-name').placeholder = folder.name;
                document.getElementById('btn-join-select').disabled = false;
                // Deselect any list selection
                document.querySelectorAll('#shared-folder-list .folder-item').forEach(function (b) { b.classList.remove('selected'); });
            } catch (e) {
                resultEl.textContent = errorCode(e) === 'ERR_NOTFOUND'
                    ? 'No folder found at that link, or it isn\u2019t shared with ' + ((authStatus && authStatus.userEmail) || 'you') + '.'
                    : describeError(e).text;
                resultEl.className = 'status-text error-text';
                selectedSharedFolder = null;
                document.getElementById('btn-join-select').disabled = true;
            }
        });

        document.getElementById('paste-folder-link').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-resolve-link').click(); }
        });

        document.getElementById('btn-join-select').addEventListener('click', async function () {
            if (!selectedSharedFolder) return;
            var name = document.getElementById('join-workspace-name').value.trim() || selectedSharedFolder.name;
            try {
                await window.go.main.App.CreateWorkspace(name, selectedSharedFolder.id);
                var workspaces = await window.go.main.App.GetWorkspaces();
                showToast('Workspace joined!', 'success');
                showWorkspacesView(workspaces);
            } catch (e) {
                showError('join the workspace', e);
            }
        });

        document.getElementById('btn-back-to-path-choice').addEventListener('click', function () {
            showView('view-path-choice');
        });

        document.getElementById('btn-signout-join').addEventListener('click', doSignOut);
    }

    async function loadSharedFolders(query) {
        var listEl = document.getElementById('shared-folder-list');
        var loadingEl = document.getElementById('shared-folder-loading');
        listEl.innerHTML = '';
        loadingEl.classList.remove('hidden');
        selectedSharedFolder = null;
        document.getElementById('btn-join-select').disabled = true;

        try {
            var folders = await window.go.main.App.SearchSharedFolders(query);
            loadingEl.classList.add('hidden');

            if (!folders || folders.length === 0) {
                listEl.innerHTML = '<div class="folder-empty">No shared folders found.' + (query ? ' Try a different search.' : '') + '</div>';
                return;
            }

            listEl.innerHTML = folders.map(function (f) {
                return '<button class="folder-item" data-id="' + f.id + '" data-name="' + escapeHtml(f.name) + '">' +
                    '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 4h4l2 2h6v7H2V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
                    '<span>' + escapeHtml(f.name) + '</span>' +
                    '<span class="folder-shared-badge">Shared</span>' +
                    '</button>';
            }).join('');

            listEl.querySelectorAll('.folder-item').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    listEl.querySelectorAll('.folder-item').forEach(function (b) { b.classList.remove('selected'); });
                    btn.classList.add('selected');
                    selectedSharedFolder = { id: btn.dataset.id, name: btn.dataset.name };
                    document.getElementById('join-workspace-name').placeholder = btn.dataset.name;
                    document.getElementById('btn-join-select').disabled = false;
                });
            });
        } catch (e) {
            loadingEl.classList.add('hidden');
            console.error('SearchSharedFolders:', errorMessage(e));
            listEl.innerHTML = '<div class="folder-empty">' + escapeHtml(describeError(e, 'load shared folders').text) + '</div>';
        }
    }

    async function loadFolders(parentId) {
        var listEl = document.getElementById('folder-list');
        var loadingEl = document.getElementById('folder-loading');
        listEl.innerHTML = '';
        loadingEl.classList.remove('hidden');

        try {
            var folders = await window.go.main.App.ListDriveFolders(parentId);
            loadingEl.classList.add('hidden');

            if (!folders || folders.length === 0) {
                listEl.innerHTML = '<div class="folder-empty">No subfolders. You can create one or use this folder.</div>';
                return;
            }

            listEl.innerHTML = folders.map(function (f) {
                return '<button class="folder-item" data-id="' + f.id + '" data-name="' + escapeHtml(f.name) + '">' +
                    '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 4h4l2 2h6v7H2V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
                    '<span>' + escapeHtml(f.name) + '</span>' +
                    '</button>';
            }).join('');

            listEl.querySelectorAll('.folder-item').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    currentFolderPath.push({ id: btn.dataset.id, name: btn.dataset.name });
                    renderBreadcrumb();
                    loadFolders(btn.dataset.id);
                });
            });
        } catch (e) {
            loadingEl.classList.add('hidden');
            console.error('ListDriveFolders:', errorMessage(e));
            listEl.innerHTML = '<div class="folder-empty">' + escapeHtml(describeError(e, 'load your Drive folders').text) + '</div>';
        }
    }

    function renderBreadcrumb() {
        var el = document.getElementById('folder-breadcrumb');
        el.innerHTML = currentFolderPath.map(function (item, i) {
            return '<button class="breadcrumb-item" data-idx="' + i + '">' + escapeHtml(item.name) + '</button>';
        }).join(' <span class="breadcrumb-sep">/</span> ');

        el.querySelectorAll('.breadcrumb-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var idx = parseInt(btn.dataset.idx);
                currentFolderPath = currentFolderPath.slice(0, idx + 1);
                renderBreadcrumb();
                loadFolders(currentFolderPath[idx].id);
            });
        });
    }

    // === Editor View ===

    function initEditorIfNeeded() {
        if (editor) return;

        editor = new TipTap.Editor({
            element: document.getElementById('editor'),
            extensions: editorExtensions(true),
            onUpdate: function () { onEditorChange(); },
            editorProps: {
                handleDrop: function (view, event, slice, moved) {
                    // If this is an internal ProseMirror drag (moved=true), let it handle natively
                    if (moved) return false;
                    // Handle image files dropped from OS
                    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
                        handleImageFiles(event.dataTransfer.files, view, event);
                        return true;
                    }
                    return false;
                },
                handlePaste: function (view, event) {
                    var items = event.clipboardData && event.clipboardData.items;
                    if (items) {
                        for (var i = 0; i < items.length; i++) {
                            if (items[i].type.indexOf('image') === 0) {
                                event.preventDefault();
                                uploadAndInsertImage(items[i].getAsFile());
                                return true;
                            }
                        }
                    }
                    return false;
                },
            },
        });

        // Build the toolbar for TipTap (it doesn't include one by default)
        buildEditorToolbar();

        // Links open in the browser with Ctrl+click (plain clicks edit text).
        document.getElementById('editor').addEventListener('click', function (e) {
            var a = e.target.closest('a[href]');
            if (!a || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            var url = normalizeUrl(a.getAttribute('href'));
            if (url && window.runtime) window.runtime.BrowserOpenURL(url);
        });
    }

    // normalizeUrl accepts web and mail links only; a bare domain gets https://.
    function normalizeUrl(raw) {
        var url = (raw || '').trim();
        if (!url) return '';
        if (/^mailto:/i.test(url)) return url;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
        return /^https?:\/\/[^\s]+$/i.test(url) ? url : '';
    }

    // editLink adds, changes or removes the link on the selection.
    async function editLink() {
        if (!editor) return;
        var prev = editor.getAttributes('link').href || '';
        var choices = [];
        if (prev) choices.push({ id: 'link-remove', label: 'Remove link', value: 'remove', kind: 'secondary' });
        choices.push({ id: 'link-ok', label: prev ? 'Update link' : 'Add link', value: 'ok', kind: 'primary' });
        var res = await askText({
            title: prev ? 'Edit link' : 'Add link',
            body: '',
            label: 'Web address',
            value: prev,
            placeholder: 'https://example.com',
            choices: choices,
        });
        if (!res) return;
        var chain = editor.chain().focus().extendMarkRange('link');
        if (res.choice === 'remove') { chain.unsetLink().run(); return; }
        var url = normalizeUrl(res.text);
        if (!url) { showToast('Enter a web address such as https://example.com', 'warning'); return; }
        if (editor.state.selection.empty && !prev) {
            editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
        } else {
            chain.setLink({ href: url }).run();
        }
    }

    // editorExtensions builds the extension list shared by the main editor
    // and the read-only version preview.
    function editorExtensions(editable) {
        return [
            TipTap.StarterKit,
            TipTap.Image.configure({ inline: false, allowBase64: false, HTMLAttributes: { draggable: editable ? 'true' : 'false' } }),
            TipTap.Placeholder.configure({ placeholder: editable ? 'Start writing...' : '' }),
            TipTap.Table.configure({ resizable: editable }),
            TipTap.TableRow,
            TipTap.TableCell,
            TipTap.TableHeader,
            TipTap.TaskList,
            TipTap.TaskItem.configure({ nested: true }),
            TipTap.Link.configure({ openOnClick: false }),
            TipTap.Markdown,
        ];
    }

    // The version preview is a read-only editor, so it looks like the page.
    var previewEditor = null;

    function showPreviewMarkdown(markdown) {
        var el = document.getElementById('history-preview-content');
        if (!previewEditor) {
            previewEditor = new TipTap.Editor({ element: el, editable: false, extensions: editorExtensions(false) });
        }
        previewEditor.commands.setContent(markdown || '', { emitUpdate: false });
        el.scrollTop = 0;
    }

    function setPreviewStatus(text) {
        var st = document.getElementById('history-preview-status');
        st.textContent = text || '';
        st.classList.toggle('hidden', !text);
        document.getElementById('history-preview-content').classList.toggle('hidden', !!text);
    }

    async function uploadAndInsertImage(file) {
        var url = await uploadImageBlob(file);
        if (url && editor) {
            editor.chain().focus().setImage({ src: url, alt: file.name || 'image' }).run();
        }
    }

    async function handleImageFiles(files, view, event) {
        for (var i = 0; i < files.length; i++) {
            if (!files[i].type.startsWith('image/')) continue;
            await uploadAndInsertImage(files[i]);
        }
    }

    async function uploadImageBlob(blob) {
        return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = async function () {
                try {
                    var base64 = reader.result.split(',')[1];
                    var url = await window.go.main.App.UploadImage(base64, blob.name || 'image.png');
                    url = url.replace(/^\/+/, '/');
                    resolve(url);
                } catch (e) {
                    showError('add the image', e);
                    resolve(null);
                }
            };
            reader.readAsDataURL(blob);
        });
    }

    function buildEditorToolbar() {
        var toolbar = document.createElement('div');
        toolbar.className = 'editor-toolbar';

        var ICON_LINK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        var ICON_UNDO = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3L2 6l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 6H10a4 4 0 010 8H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        var ICON_REDO = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 6H6a4 4 0 000 8h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

        // name: accessible name and tooltip; keys: TipTap's built-in shortcut
        // (see the extensions' addKeyboardShortcuts), shown in the tooltip.
        var groups = [
            [
                { icon: ICON_UNDO, name: 'Undo', keys: 'Mod+Z', cmd: function () { editor.chain().focus().undo().run(); }, enabled: function () { return editor.can().undo(); } },
                { icon: ICON_REDO, name: 'Redo', keys: 'Mod+Y', cmd: function () { editor.chain().focus().redo().run(); }, enabled: function () { return editor.can().redo(); } },
            ],
            [
                { label: 'H1', name: 'Heading 1', keys: 'Mod+Alt+1', cmd: function () { editor.chain().focus().toggleHeading({ level: 1 }).run(); }, active: function () { return editor.isActive('heading', { level: 1 }); } },
                { label: 'H2', name: 'Heading 2', keys: 'Mod+Alt+2', cmd: function () { editor.chain().focus().toggleHeading({ level: 2 }).run(); }, active: function () { return editor.isActive('heading', { level: 2 }); } },
                { label: 'H3', name: 'Heading 3', keys: 'Mod+Alt+3', cmd: function () { editor.chain().focus().toggleHeading({ level: 3 }).run(); }, active: function () { return editor.isActive('heading', { level: 3 }); } },
            ],
            [
                { label: 'B', name: 'Bold', keys: 'Mod+B', cmd: function () { editor.chain().focus().toggleBold().run(); }, active: function () { return editor.isActive('bold'); }, style: 'font-weight:bold' },
                { label: 'I', name: 'Italic', keys: 'Mod+I', cmd: function () { editor.chain().focus().toggleItalic().run(); }, active: function () { return editor.isActive('italic'); }, style: 'font-style:italic' },
                { label: 'S', name: 'Strikethrough', keys: 'Mod+Shift+S', cmd: function () { editor.chain().focus().toggleStrike().run(); }, active: function () { return editor.isActive('strike'); }, style: 'text-decoration:line-through' },
                { label: '<>', name: 'Inline code', keys: 'Mod+E', cmd: function () { editor.chain().focus().toggleCode().run(); }, active: function () { return editor.isActive('code'); } },
                { icon: ICON_LINK, name: 'Link', keys: '', cmd: function () { editLink(); }, active: function () { return editor.isActive('link'); } },
            ],
            [
                { label: '—', name: 'Horizontal rule', keys: '', hint: 'or type --- on an empty line', cmd: function () { editor.chain().focus().setHorizontalRule().run(); } },
                { label: '“', name: 'Quote', keys: 'Mod+Shift+B', cmd: function () { editor.chain().focus().toggleBlockquote().run(); }, active: function () { return editor.isActive('blockquote'); } },
            ],
            [
                { label: '•', name: 'Bullet list', keys: 'Mod+Shift+8', cmd: function () { editor.chain().focus().toggleBulletList().run(); }, active: function () { return editor.isActive('bulletList'); } },
                { label: '1.', name: 'Numbered list', keys: 'Mod+Shift+7', cmd: function () { editor.chain().focus().toggleOrderedList().run(); }, active: function () { return editor.isActive('orderedList'); } },
                { label: '☑', name: 'Task list', keys: 'Mod+Shift+9', cmd: function () { editor.chain().focus().toggleTaskList().run(); }, active: function () { return editor.isActive('taskList'); } },
            ],
            [
                { label: '⊞', name: 'Table', keys: '', cmd: function () { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
                {
                    label: '🖼', name: 'Image', keys: '', hint: 'or paste / drop an image', cmd: function () {
                        var input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.onchange = function () { if (input.files[0]) uploadAndInsertImage(input.files[0]); };
                        input.click();
                    }
                },
            ],
            [
                { label: '{}', name: 'Code block', keys: 'Mod+Alt+C', cmd: function () { editor.chain().focus().toggleCodeBlock().run(); }, active: function () { return editor.isActive('codeBlock'); } },
            ],
        ];

        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Formatting');

        groups.forEach(function (group, gi) {
            if (gi > 0) {
                var sep = document.createElement('span');
                sep.className = 'toolbar-sep';
                sep.setAttribute('aria-hidden', 'true');
                toolbar.appendChild(sep);
            }
            group.forEach(function (btn) {
                var el = document.createElement('button');
                el.className = 'toolbar-btn';
                if (btn.icon) el.innerHTML = btn.icon; else el.textContent = btn.label;
                el.setAttribute('aria-label', btn.name);
                el.title = btn.name + (btn.keys ? ' (' + shortcutLabel(btn.keys) + ')' : '') + (btn.hint ? ' — ' + btn.hint : '');
                if (btn.keys) el.setAttribute('aria-keyshortcuts', btn.keys.replace('Mod', isMac ? 'Meta' : 'Control'));
                if (btn.active) el.setAttribute('aria-pressed', 'false');
                if (btn.style) el.setAttribute('style', btn.style);
                // Keep the editor's selection: act on mousedown's default being prevented.
                el.addEventListener('mousedown', function (e) { e.preventDefault(); });
                el.addEventListener('click', function (e) { e.preventDefault(); btn.cmd(); updateToolbarState(); });
                toolbar.appendChild(el);
            });
        });

        // Insert toolbar before the ProseMirror editor
        var editorEl = document.getElementById('editor');
        editorEl.parentNode.insertBefore(toolbar, editorEl);

        // Update active states on selection change
        editor.on('selectionUpdate', updateToolbarState);
        editor.on('update', updateToolbarState);

        function updateToolbarState() {
            var buttons = toolbar.querySelectorAll('.toolbar-btn');
            var idx = 0;
            groups.forEach(function (group) {
                group.forEach(function (btn) {
                    var el = buttons[idx++];
                    if (!el) return;
                    if (btn.active) {
                        var on = !!btn.active();
                        el.classList.toggle('active', on);
                        el.setAttribute('aria-pressed', on ? 'true' : 'false');
                    }
                    if (btn.enabled) el.disabled = !btn.enabled();
                });
            });
        }
        updateToolbarState();
        refreshToolbar = updateToolbarState;
    }

    function bindEditorEvents() {
        document.getElementById('btn-new-page').addEventListener('click', function () { createDocument('', false); });
        document.getElementById('btn-new-folder').addEventListener('click', function () { createDocument('', true); });
        document.getElementById('btn-create-first').addEventListener('click', function () { createDocument('', false); });
        document.getElementById('btn-delete-doc').addEventListener('click', deleteCurrentDoc);

        document.getElementById('doc-title').addEventListener('input', onTitleChange);
        document.getElementById('doc-title').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); if (editor) editor.commands.focus(); }
        });

        var searchTimeout;
        document.getElementById('search-input').addEventListener('input', function () {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(doSearch, 300);
        });
        document.getElementById('search-input').addEventListener('blur', function () {
            setTimeout(function () { document.getElementById('search-results').classList.add('hidden'); }, 200);
        });

        document.addEventListener('click', function () { document.getElementById('context-menu').classList.add('hidden'); });
        document.querySelectorAll('#context-menu button').forEach(function (btn) {
            btn.addEventListener('click', onContextAction);
        });

        // Right-click on sidebar empty space → create at root level
        var pageTreeEl = document.getElementById('page-tree');
        if (pageTreeEl) {
            // Dropping on empty space moves to the end of the top level.
            pageTreeEl.addEventListener('dragover', function (e) {
                if (!dragId || e.target.closest('.tree-item')) return;
                e.preventDefault();
                clearDropMarks();
                pageTreeEl.classList.add('drop-root');
            });
            pageTreeEl.addEventListener('dragleave', function (e) {
                if (e.target === pageTreeEl) pageTreeEl.classList.remove('drop-root');
            });
            pageTreeEl.addEventListener('drop', function (e) {
                if (!dragId || e.target.closest('.tree-item')) return;
                e.preventDefault();
                var id = dragId;
                dragId = null;
                clearDropMarks();
                moveDocument(id, '', '');
            });
            document.getElementById('btn-close-move').addEventListener('click', closeMovePicker);
            document.getElementById('move-modal').addEventListener('mousedown', function (e) {
                if (e.target.id === 'move-modal') closeMovePicker();
            });
            document.getElementById('move-modal').addEventListener('keydown', function (e) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    var opts = Array.prototype.slice.call(document.querySelectorAll('#move-list .move-option:not([disabled])'));
                    var i = opts.indexOf(document.activeElement);
                    var next = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length];
                    if (next) next.focus();
                }
            });

            // Double-click or F2 renames in place.
            pageTreeEl.addEventListener('dblclick', function (e) {
                var item = e.target.closest('.tree-item');
                if (!item || e.target.closest('.tree-toggle')) return;
                e.preventDefault();
                startInlineRename(item.dataset.id);
            });
            pageTreeEl.addEventListener('keydown', onTreeKeydown);
            bindMenuKeys(document.getElementById('context-menu'));
            bindMenuKeys(document.getElementById('ws-context-menu'));
            pageTreeEl.addEventListener('keydown', function (e) {
                if (e.key !== 'F2') return;
                var item = e.target.closest('.tree-item') || pageTreeEl.querySelector('.tree-item.selected');
                if (!item) return;
                e.preventDefault();
                startInlineRename(item.dataset.id);
            });
            pageTreeEl.addEventListener('contextmenu', function (e) {
                // Only fire if clicking the sidebar background, not a tree item
                if (e.target.closest('.tree-item')) return;
                e.preventDefault();
                showContextMenu(e, null);
            });
        }

        // Global shortcuts: Ctrl+N new page, Ctrl+K search, Ctrl+Shift+P
        // publish, Esc closes menus and dialogs.
        document.addEventListener('keydown', onGlobalKeydown);

        // Capture phase Ctrl+S for save (prevent browser default)
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                e.stopImmediatePropagation();
                saveNow();
            }
        }, true);

        document.getElementById('btn-back-ws').addEventListener('click', async function () {
            if (currentDocId) await saveNow();
            currentDocId = null;
            var workspaces = await window.go.main.App.GetWorkspaces();
            showWorkspacesView(workspaces);
        });

        document.getElementById('btn-sync').addEventListener('click', function () { triggerSync(); });
        document.getElementById('btn-open-drive').addEventListener('click', openWorkspaceInDrive);
        document.getElementById('btn-publish').addEventListener('click', publishCurrentDoc);

        document.getElementById('btn-share').addEventListener('click', function () {
            document.getElementById('sharing-modal').classList.remove('hidden');
            loadMembers();
        });

        document.getElementById('btn-history').addEventListener('click', openVersionHistory);

        document.getElementById('btn-dismiss-draft-hint').addEventListener('click', function () {
            draftHintDismissed = true;
            renderDocStatus();
            window.go.main.App.SetUIState('draft-hint-dismissed', '1').catch(function (e) { console.error('SetUIState:', errorMessage(e)); });
        });
    }

    function onGlobalKeydown(e) {
        if (sheetResolve) return; // the confirmation sheet handles its own keys
        var mod = e.ctrlKey || e.metaKey;
        var inEditorView = currentView() === 'view-editor';

        if (e.key === 'Escape') {
            if (closeTopLayer()) e.preventDefault();
            return;
        }
        if (!mod || !inEditorView) return;
        var key = e.key.toLowerCase();

        if (key === 'n' && !e.shiftKey && !e.altKey) {
            e.preventDefault(); // WebView2 would open a new window
            var cur = currentDocId ? findDoc(currentDocId) : null;
            createDocument(cur ? (cur.parentId || '') : '', false);
        } else if (key === 'k' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            var search = document.getElementById('search-input');
            search.focus();
            search.select();
        } else if (key === 'p' && e.shiftKey) {
            e.preventDefault();
            var btn = document.getElementById('btn-publish');
            if (currentDocId && btn.style.display !== 'none' && !btn.disabled) publishCurrentDoc();
        }
    }

    // closeTopLayer closes the topmost open menu, search result list or
    // dialog. Returns whether anything was closed.
    function closeTopLayer() {
        var menus = ['context-menu', 'ws-context-menu'].map(function (id) { return document.getElementById(id); })
            .filter(function (m) { return m && !m.classList.contains('hidden'); });
        if (menus.length) {
            menus.forEach(function (m) { m.classList.add('hidden'); });
            restoreMenuFocus();
            return true;
        }
        var results = document.getElementById('search-results');
        if (!results.classList.contains('hidden')) {
            results.classList.add('hidden');
            document.getElementById('search-input').blur();
            return true;
        }
        var modals = ['move-modal', 'history-modal', 'sharing-modal', 'settings-modal'];
        for (var i = 0; i < modals.length; i++) {
            var m = document.getElementById(modals[i]);
            if (m && !m.classList.contains('hidden')) {
                m.classList.add('hidden');
                return true;
            }
        }
        return false;
    }

    // === Sync & Publish ===
    // triggerSync pulls published pages from Drive. opts.quiet (automatic
    // refreshes) shows a toast only when something changed and reports
    // failures in the status bar instead of a toast. Concurrent calls share
    // one refresh.
    function triggerSync(opts) {
        var quiet = !!(opts && opts.quiet === true);
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = runRefresh(quiet).finally(function () { refreshInFlight = null; });
        return refreshInFlight;
    }

    async function runRefresh(quiet) {
        var syncBtn = document.getElementById('btn-sync');
        var statusEl = document.getElementById('sync-status-text');
        // Save pending typing first: a saved edit makes the page a draft, and
        // a refresh never overwrites drafts.
        if (currentDocId && window.__hexnoteHasUnsaved) await saveNow();
        lastRefreshAt = Date.now();
        syncBtn.classList.add('syncing');
        statusEl.textContent = 'Refreshing from Drive\u2026';
        try {
            var sum = await window.go.main.App.TriggerSync();
            var updated = (sum && sum.updated) || [];
            statusEl.textContent = 'Refreshed from Drive at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            await loadTree();
            if (updated.length) {
                showToast(updated.length === 1 ? '1 page updated from Drive' : updated.length + ' pages updated from Drive', 'info');
            } else if (!quiet && !((sum && sum.removed && sum.removed.length) || (sum && sum.detached && sum.detached.length))) {
                showToast('Already up to date', 'success', 2500);
            }
        } catch (e) {
            if (quiet) {
                console.error('[auto-refresh]', errorMessage(e));
                statusEl.textContent = errorCode(e) === 'ERR_OFFLINE'
                    ? 'Offline. Your pages are saved on this PC.'
                    : 'Couldn\u2019t refresh from Drive';
            } else {
                statusEl.textContent = 'Couldn\u2019t refresh from Drive';
                showError('refresh from Drive', e, triggerSync);
            }
        } finally {
            syncBtn.classList.remove('syncing');
        }
    }

    // scheduleAutoRefresh (re)starts the periodic refresh timer.
    function scheduleAutoRefresh() {
        clearInterval(refreshTimer);
        refreshTimer = null;
        if (syncIntervalSecs > 0) {
            refreshTimer = setInterval(function () { autoRefresh('timer'); }, syncIntervalSecs * 1000);
        }
    }

    // autoRefresh refreshes quietly while a workspace is open. Focus-triggered
    // refreshes are throttled to one a minute.
    function autoRefresh(reason) {
        if (currentView() !== 'view-editor' || !activeWorkspace) return;
        if (reason === 'focus' && Date.now() - lastRefreshAt < 60000) return;
        triggerSync({ quiet: true });
    }

    function isOpenPageClean() {
        return !window.__hexnoteHasUnsaved && saveState === 'saved' &&
            !!currentDocMeta && currentDocMeta.status === 'published';
    }

    // reloadCurrentDoc shows the stored version of the open page (after a
    // teammate's change came in from Drive).
    async function reloadCurrentDoc() {
        var id = currentDocId;
        try {
            var doc = await window.go.main.App.GetDocument(id);
            if (id !== currentDocId || !isOpenPageClean()) return; // user moved on or started typing
            applyDocToEditor(doc);
        } catch (e) {
            console.error('reloadCurrentDoc:', errorMessage(e));
        }
    }

    async function publishCurrentDoc() {
        if (!currentDocId) return;
        var btn = document.getElementById('btn-publish');
        btn.disabled = true;
        btn.textContent = 'Publishing...';
        try {
            await publishDocument(currentDocId);
        } finally {
            btn.disabled = false;
            renderDocStatus();
        }
    }

    // publishDocument publishes a page or folder (saving the open page first)
    // and reports whether it succeeded.
    async function publishDocument(id) {
        if (id === currentDocId) await saveNow();
        try {
            var doc = await window.go.main.App.PublishDocument(id);
            if (id === currentDocId) setDocMeta(doc);
            showToast(doc && doc.isFolder ? 'Folder published to Drive' : 'Published to Drive', 'success');
            await loadTree();
            return true;
        } catch (e) {
            if (errorCode(e) === 'ERR_CONFLICT') return resolveConflict(id, e);
            showError('publish', e, function () { publishDocument(id); });
            return false;
        }
    }

    // resolveConflict runs when Publish finds a newer version on Drive than
    // the one this PC last saw. The user picks: overwrite theirs, load theirs
    // (discarding local edits after a second confirmation), or keep both.
    async function resolveConflict(id, e) {
        var info = {};
        try { info = JSON.parse(errorMessage(e).replace(/^ERR_CONFLICT:\s*/, '')); } catch (err) { /* keep defaults */ }
        var who = info.by || 'Someone';
        var when = info.at ? new Date(info.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
        var doc = findDoc(id);
        var title = doc ? doc.title : 'this page';

        var choice = await askChoice({
            title: who + ' changed \u201c' + title + '\u201d on Drive',
            body: who + ' published a newer version' + (when ? ' (' + when + ')' : '') +
                ' after this PC last refreshed the page. Publishing now would replace their text with yours.',
            choices: [
                { id: 'conflict-theirs', label: 'Load theirs', value: 'theirs', kind: 'secondary' },
                { id: 'conflict-both', label: 'Keep both', value: 'both', kind: 'primary' },
                { id: 'conflict-overwrite', label: 'Overwrite theirs', value: 'overwrite', kind: 'danger' },
            ],
        });

        try {
            if (choice === 'overwrite') {
                var pub = await window.go.main.App.ForcePublishDocument(id);
                if (id === currentDocId) setDocMeta(pub);
                await loadTree();
                showToast('Published. ' + who + '\u2019s version is still in Version History.', 'success', 6000);
                return true;
            }
            if (choice === 'theirs') {
                var sure = await askConfirm('Discard your unpublished edits?',
                    'Your changes to \u201c' + title + '\u201d are replaced by ' + who + '\u2019s version. They cannot be recovered.',
                    'Discard my edits', true);
                if (!sure) return false;
                var theirs = await window.go.main.App.DiscardLocalChanges(id);
                if (id === currentDocId) applyDocToEditor(theirs);
                await loadTree();
                showToast('Loaded ' + who + '\u2019s version', 'success');
                return true;
            }
            if (choice === 'both') {
                var mine = await window.go.main.App.KeepBothVersions(id);
                if (id === currentDocId) applyDocToEditor(await window.go.main.App.GetDocument(id));
                await loadTree();
                showToast('Your text is saved as \u201c' + mine.title + '\u201d (not published yet).', 'success', 8000,
                    { label: 'Open', run: function () { selectDocument(mine.id); } });
                return true;
            }
        } catch (err) {
            showError('resolve the conflict', err);
        }
        return false;
    }

    // applyDocToEditor shows a stored document in the editor as saved.
    function applyDocToEditor(doc) {
        clearTimeout(saveTimeout);
        document.getElementById('doc-title').value = doc.title;
        loadEditorContent(doc.content);
        markClean(doc.title);
        saveState = 'saved';
        setDocMeta(doc);
    }

    // renameDocument changes only the title of a page or folder. A folder
    // rename goes to Drive right away when possible.
    async function renameDocument(doc, title) {
        var isCurrent = currentDocId === doc.id;
        // Flush pending body edits first so the rename cannot race them.
        if (isCurrent) await saveNow();
        try {
            var updated = await window.go.main.App.RenameDocument(doc.id, title);
            if (isCurrent) {
                document.getElementById('doc-title').value = updated.title;
                lastKnownTitle = updated.title;
                setDocMeta(updated);
            }
            if (updated.isFolder && updated.driveFileId && updated.status === 'draft') {
                showToast('Renamed on this PC. Publish the folder to rename it on Drive.', 'warning', 6000);
            }
            await loadTree();
        } catch (e) {
            showError('rename', e);
        }
    }

    // === Sharing Modal ===
    function bindSharingEvents() {
        document.getElementById('btn-close-sharing').addEventListener('click', function () {
            document.getElementById('sharing-modal').classList.add('hidden');
        });

        document.getElementById('btn-share-invite').addEventListener('click', async function () {
            var email = document.getElementById('share-email').value.trim();
            var role = document.getElementById('share-role').value;
            if (!email || !activeWorkspace) return;
            try {
                await window.go.main.App.ShareWorkspace(activeWorkspace.id, email, role);
                document.getElementById('share-email').value = '';
                showToast('Invitation sent to ' + email, 'success');
                loadMembers();
            } catch (e) {
                showError('share the workspace', e);
            }
        });
    }

    async function loadMembers() {
        if (!activeWorkspace) return;
        var listEl = document.getElementById('member-list');
        try {
            var members = await window.go.main.App.GetWorkspaceMembers(activeWorkspace.id);
            if (!members || members.length === 0) {
                listEl.innerHTML = '<p class="member-empty">No collaborators yet.</p>';
                return;
            }
            listEl.innerHTML = members.map(function (m) {
                return '<div class="member-item">' +
                    '<div><strong>' + escapeHtml(m.displayName || m.email) + '</strong>' +
                    (m.displayName ? '<br><span class="text-muted">' + escapeHtml(m.email) + '</span>' : '') +
                    '</div>' +
                    '<span class="member-role">' + m.role + '</span>' +
                    (m.role !== 'owner' ? '<button class="btn-icon btn-danger member-remove" data-email="' + escapeHtml(m.email) + '" title="Remove access" aria-label="Remove ' + escapeHtml(m.email) + '">&times;</button>' : '') +
                    '</div>';
            }).join('');

            listEl.querySelectorAll('.member-remove').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    var email = btn.dataset.email;
                    var ok = await askConfirm('Remove ' + email + '?',
                        'They lose access to this workspace\u2019s Google Drive folder and stop seeing its pages. You can invite them again later.',
                        'Remove access', true);
                    if (!ok) return;
                    try {
                        await window.go.main.App.RemoveWorkspaceMember(activeWorkspace.id, email);
                    } catch (e) {
                        showError('remove ' + email, e);
                    }
                    loadMembers();
                });
            });
        } catch (e) {
            listEl.innerHTML = '<p class="member-empty">Error loading members.</p>';
        }
    }

    // === Version History ===
    async function openVersionHistory() {
        if (!currentDocId) {
            showToast('Select a document first', 'warning');
            return;
        }
        var modal = document.getElementById('history-modal');
        var listEl = document.getElementById('history-list');
        var previewEl = document.getElementById('history-preview');
        previewEl.classList.add('hidden');
        listEl.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
        modal.classList.remove('hidden');
        selectedRevisionId = null;

        try {
            var revisions = await window.go.main.App.GetVersionHistory(currentDocId);
            if (!revisions || revisions.length === 0) {
                listEl.innerHTML = '<p class="history-empty">No versions yet. Every publish saves a version on Google Drive.</p>';
                return;
            }
            listEl.innerHTML = revisions.map(function (r) {
                var date = new Date(r.modifiedTime).toLocaleString();
                var user = r.lastModifyingUser || 'Unknown';
                var size = r.size || 0;
                var sizeText = size < 1024 ? size + ' bytes' : Math.round(size / 1024) + ' KB';
                return '<button class="history-item" data-rev="' + r.revisionId + '">' +
                    '<span class="history-item-date">' + date + '</span>' +
                    '<span class="history-item-user">' + escapeHtml(user) + '</span>' +
                    '<span class="history-item-size">' + sizeText + '</span>' +
                    '</button>';
            }).join('');

            listEl.querySelectorAll('.history-item').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    listEl.querySelectorAll('.history-item').forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    selectedRevisionId = btn.dataset.rev;
                    previewEl.classList.remove('hidden');
                    document.getElementById('history-preview-date').textContent = btn.querySelector('.history-item-date').textContent;
                    setPreviewStatus('Loading\u2026');
                    try {
                        var content = await window.go.main.App.PreviewRevision(currentDocId, selectedRevisionId);
                        if (selectedRevisionId !== btn.dataset.rev) return; // another version was picked meanwhile
                        setPreviewStatus('');
                        showPreviewMarkdown(content);
                    } catch (e) {
                        console.error('PreviewRevision:', errorMessage(e));
                        setPreviewStatus(describeError(e, 'load this version').text);
                    }
                });
            });
        } catch (e) {
            console.error('GetVersionHistory:', errorMessage(e));
            listEl.innerHTML = '<p class="history-empty">' + escapeHtml(describeError(e, 'load version history').text) + '</p>';
        }
    }

    function bindHistoryEvents() {
        document.getElementById('btn-close-history').addEventListener('click', function () {
            document.getElementById('history-modal').classList.add('hidden');
        });

        document.getElementById('btn-restore-version').addEventListener('click', async function () {
            if (!currentDocId || !selectedRevisionId) return;
            var when = document.getElementById('history-preview-date').textContent;
            var meta = currentDocMeta || {};
            var keepNote = meta.status === 'draft'
                ? ' Your unpublished edits are first saved as a separate draft page, so nothing is lost.'
                : ' The current text stays in this list as the newest version.';
            if (!(await askConfirm('Restore this version?',
                'The page text is replaced with the version from ' + when + '.' + keepNote +
                ' The restored text stays on this PC until you publish it.',
                'Restore'))) return;
            try {
                if (window.__hexnoteHasUnsaved) await saveNow();
                var res = await window.go.main.App.RestoreVersion(currentDocId, selectedRevisionId);
                var doc = res.document;
                loadEditorContent(doc.content);
                document.getElementById('doc-title').value = doc.title;
                markClean(doc.title);
                document.getElementById('history-modal').classList.add('hidden');
                setDocMeta(doc);
                setSaveStatus('saved');
                await loadTree();
                if (res.backupId) {
                    showToast('Version restored. Your previous text is in \u201c' + res.backupTitle + '\u201d.', 'success', 8000,
                        { label: 'Open', run: function () { selectDocument(res.backupId); } });
                } else {
                    showToast('Version restored', 'success');
                }
            } catch (e) {
                showError('restore this version', e);
            }
        });
    }

    // === Settings ===
    function bindSettingsEvents() {
        document.getElementById('btn-settings').addEventListener('click', async function () {
            try {
                var s = await window.go.main.App.GetSettings();
                document.getElementById('setting-theme').value = s.theme || 'system';
                document.getElementById('setting-autosave').value = s.autoSaveDelaySecs || 2;
                document.getElementById('setting-sync-interval').value = s.syncIntervalSecs;
                document.getElementById('settings-modal').classList.remove('hidden');
            } catch (e) {
                showError('open settings', e);
            }
        });

        document.getElementById('btn-close-settings').addEventListener('click', function () {
            document.getElementById('settings-modal').classList.add('hidden');
        });

        document.getElementById('btn-settings-signout').addEventListener('click', doSignOut);
        document.getElementById('btn-settings-credentials').addEventListener('click', async function () {
            await leaveEditor();
            showCredentialsView(true);
        });

        document.getElementById('btn-save-settings').addEventListener('click', async function () {
            var theme = document.getElementById('setting-theme').value;
            var autosave = parseInt(document.getElementById('setting-autosave').value) || 2;
            var interval = parseInt(document.getElementById('setting-sync-interval').value, 10);
            if (isNaN(interval) || interval < 0) interval = 120;
            try {
                var saved = await window.go.main.App.UpdateSettings(interval, theme, autosave);
                applyTheme(theme);
                autoSaveDelay = autosave * 1000;
                syncIntervalSecs = saved && typeof saved.syncIntervalSecs === 'number' ? saved.syncIntervalSecs : interval;
                scheduleAutoRefresh();
                document.getElementById('settings-modal').classList.add('hidden');
                showToast('Settings saved', 'success');
            } catch (e) {
                showError('save settings', e);
            }
        });

        document.getElementById('btn-export-workspace').addEventListener('click', async function () {
            try {
                var path = await window.go.main.App.ExportWorkspace();
                showToast('Exported to: ' + path, 'success', 6000);
            } catch (e) {
                // Wails rejects with a plain string, so check the text, not e.message.
                if (errorMessage(e).indexOf('no folder selected') >= 0) return; // user cancelled
                showError('export the workspace', e);
            }
        });
    }

    // === Tree, Doc CRUD, Search, Save ===

    async function loadTree() {
        try {
            tree = await window.go.main.App.GetDocumentTree();
            if (!tree) tree = [];
            renderTree();
            updateEmptyState();
        } catch (e) {
            console.error('loadTree error:', e);
        }
    }

    function renderTree() {
        var pageTree = document.getElementById('page-tree');
        // Re-rendering replaces the items; keep keyboard focus where it was.
        var active = document.activeElement;
        var refocusId = active && active.classList && active.classList.contains('tree-item') ? active.dataset.id : null;
        pageTree.innerHTML = '';
        if (!tree || tree.length === 0) return;
        tree.forEach(function (node) {
            // Hide the "assets" folder — it's an internal folder for image storage
            if (node.document.isFolder && node.document.title.toLowerCase() === 'assets') return;
            pageTree.appendChild(renderNode(node, 0));
        });
        // One item is in the Tab order: the focused, selected or first one.
        var target = (refocusId && treeItemEl(refocusId)) || pageTree.querySelector('.tree-item.selected') || pageTree.querySelector('.tree-item');
        if (target) {
            target.tabIndex = 0;
            if (refocusId) target.focus();
        }
    }

    function treeItemEl(id) {
        return document.querySelector('#page-tree .tree-item[data-id="' + cssEscape(id) + '"]');
    }

    function focusTreeItem(el) {
        if (!el) return;
        document.querySelectorAll('#page-tree .tree-item').forEach(function (n) { n.tabIndex = -1; });
        el.tabIndex = 0;
        el.focus();
    }

    // onTreeKeydown implements the tree keyboard pattern: arrows move and
    // expand/collapse, Enter/Space opens, Delete deletes, Shift+F10 or the
    // Menu key opens the context menu. (F2 renames; see bindEditorEvents.)
    function onTreeKeydown(e) {
        var item = e.target.closest && e.target.closest('.tree-item');
        if (!item || e.target.tagName === 'INPUT') return;
        var doc = findDoc(item.dataset.id);
        if (!doc) return;
        var items = Array.prototype.slice.call(document.querySelectorAll('#page-tree .tree-item'));
        var i = items.indexOf(item);
        var expanded = expandedFolders.has(doc.id);

        switch (e.key) {
            case 'ArrowDown': focusTreeItem(items[Math.min(i + 1, items.length - 1)]); break;
            case 'ArrowUp': focusTreeItem(items[Math.max(i - 1, 0)]); break;
            case 'Home': focusTreeItem(items[0]); break;
            case 'End': focusTreeItem(items[items.length - 1]); break;
            case 'ArrowRight':
                if (doc.isFolder && !expanded) toggleFolder(doc.id);
                else if (doc.isFolder) focusTreeItem(items[i + 1] && isDescendant(items[i + 1].dataset.id, doc.id) ? items[i + 1] : item);
                break;
            case 'ArrowLeft':
                if (doc.isFolder && expanded) toggleFolder(doc.id);
                else if (doc.parentId) focusTreeItem(treeItemEl(doc.parentId));
                break;
            case 'Enter':
            case ' ':
                if (doc.isFolder) toggleFolder(doc.id); else selectDocument(doc.id);
                break;
            case 'Delete':
                deleteDocument(doc);
                break;
            case 'ContextMenu':
                showContextMenu(anchorEvent(item), doc, true);
                break;
            case 'F10':
                if (!e.shiftKey) return;
                showContextMenu(anchorEvent(item), doc, true);
                break;
            default:
                return;
        }
        e.preventDefault();
    }

    // anchorEvent fakes a mouse position just below an element, for menus
    // opened from the keyboard.
    function anchorEvent(el) {
        var r = el.getBoundingClientRect();
        return { clientX: Math.round(r.left + 24), clientY: Math.round(r.bottom) };
    }

    // Keyboard support shared by the context menus: arrows move between
    // visible items; focus returns to where the menu was opened from.
    var menuReturnFocus = null;

    function focusMenu(menu) {
        var first = visibleMenuItems(menu)[0];
        if (first) first.focus();
    }

    function visibleMenuItems(menu) {
        return Array.prototype.slice.call(menu.querySelectorAll('button')).filter(function (b) { return b.style.display !== 'none'; });
    }

    function bindMenuKeys(menu) {
        menu.addEventListener('keydown', function (e) {
            var items = visibleMenuItems(menu);
            var i = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
            else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
            else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
            else if (e.key === 'Tab') { e.preventDefault(); closeTopLayer(); }
        });
    }

    function restoreMenuFocus() {
        var el = menuReturnFocus;
        menuReturnFocus = null;
        if (el && document.body.contains(el)) el.focus();
    }

    function renderNode(node, depth) {
        var doc = node.document;
        var el = document.createElement('div');
        el.className = 'tree-item' + (doc.id === currentDocId ? ' selected' : '');
        el.dataset.id = doc.id;
        el.setAttribute('role', 'treeitem');
        el.setAttribute('aria-level', String(depth + 1));
        el.setAttribute('aria-selected', doc.id === currentDocId ? 'true' : 'false');
        el.tabIndex = -1;
        el.style.paddingLeft = (12 + depth * 20) + 'px';

        var isExpanded = expandedFolders.has(doc.id);
        var hasChildren = node.children && node.children.length > 0;
        var icon = doc.isFolder
            ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h4l2 2h6v7H2V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>';

        var toggle = doc.isFolder
            ? '<span class="tree-toggle ' + (isExpanded ? 'expanded' : '') + (hasChildren ? '' : ' invisible') + '">\u25B6</span>'
            : '<span class="tree-toggle invisible">\u25B6</span>';

        var statusBadge = '';
        if (doc.status === 'draft' && doc.driveFileId) {
            statusBadge = doc.isFolder
                ? '<span class="tree-badge badge-modified" title="Renamed on this PC only. Publish the folder to rename it on Drive.">Renamed</span>'
                : '<span class="tree-badge badge-modified" title="Unpublished changes">Modified</span>';
        } else if (doc.status === 'draft') {
            statusBadge = doc.isFolder
                ? '<span class="tree-badge badge-draft" title="Not on Drive yet. It is created there when you publish a page inside it.">Draft</span>'
                : '<span class="tree-badge badge-draft" title="Draft">Draft</span>';
        }
        el.innerHTML = toggle + '<span class="tree-icon">' + icon + '</span><span class="tree-label">' + escapeHtml(doc.title || 'Untitled') + '</span>' + statusBadge;

        el.addEventListener('click', function (e) {
            e.stopPropagation();
            if (doc.isFolder) { toggleFolder(doc.id); } else { selectDocument(doc.id); }
        });
        el.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation();
            showContextMenu(e, doc);
        });
        bindTreeDrag(el, doc);

        var container = document.createElement('div');
        container.className = 'tree-node';
        container.appendChild(el);

        if (doc.isFolder) el.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        if (doc.isFolder && isExpanded && node.children) {
            var childDiv = document.createElement('div');
            childDiv.className = 'tree-children';
            childDiv.setAttribute('role', 'group');
            node.children.forEach(function (child) { childDiv.appendChild(renderNode(child, depth + 1)); });
            container.appendChild(childDiv);
        }
        return container;
    }

    // === Moving pages: drag and drop, and the Move to... picker ===
    var dragId = null;

    function bindTreeDrag(el, doc) {
        el.draggable = true;
        el.addEventListener('dragstart', function (e) {
            dragId = doc.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-hexnote-doc', doc.id);
            el.classList.add('dragging');
        });
        el.addEventListener('dragend', function () {
            dragId = null;
            clearDropMarks();
        });
        el.addEventListener('dragover', function (e) {
            if (!dragId) return;
            var zone = dropZone(e, el, doc);
            clearDropMarks();
            if (!zone) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            el.classList.add('drop-' + zone);
        });
        el.addEventListener('drop', function (e) {
            if (!dragId) return;
            var zone = dropZone(e, el, doc);
            var id = dragId;
            clearDropMarks();
            if (!zone) return;
            e.preventDefault();
            e.stopPropagation();
            dragId = null;
            dropOn(id, doc, zone);
        });
    }

    // dropZone decides what a drop at the pointer means: 'before' or 'after'
    // the item (reorder among its siblings), or 'into' a folder (middle half).
    // Returns null where the drop is not allowed.
    function dropZone(e, el, target) {
        if (target.id === dragId || isDescendant(target.id, dragId)) return null;
        var r = el.getBoundingClientRect();
        var y = (e.clientY - r.top) / Math.max(r.height, 1);
        if (target.isFolder) return y < 0.25 ? 'before' : (y > 0.75 ? 'after' : 'into');
        return y < 0.5 ? 'before' : 'after';
    }

    function clearDropMarks() {
        document.querySelectorAll('.tree-item.drop-before, .tree-item.drop-after, .tree-item.drop-into, .tree-item.dragging')
            .forEach(function (n) { n.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging'); });
        document.getElementById('page-tree').classList.remove('drop-root');
    }

    function siblingsOf(parentId) {
        var list = [];
        if (!parentId) list = tree;
        else (function walk(nodes) {
            (nodes || []).forEach(function (n) {
                if (n.document.id === parentId) list = n.children || [];
                else walk(n.children);
            });
        })(tree);
        return list.map(function (n) { return n.document; });
    }

    function dropOn(id, target, zone) {
        var parentId, beforeId;
        if (zone === 'into') {
            parentId = target.id;
            beforeId = '';
        } else {
            parentId = target.parentId || '';
            beforeId = target.id;
            if (zone === 'after') {
                var sibs = siblingsOf(parentId);
                var i = sibs.findIndex(function (d) { return d.id === target.id; });
                beforeId = (i >= 0 && i + 1 < sibs.length) ? sibs[i + 1].id : '';
                if (beforeId === id) return; // already right after target
            }
        }
        moveDocument(id, parentId, beforeId);
    }

    async function moveDocument(id, parentId, beforeId) {
        try {
            var moved = await window.go.main.App.MoveDocumentTo(id, parentId, beforeId || '');
            if (parentId) expandedFolders.add(parentId);
            if (id === currentDocId && moved) setDocMeta(moved);
            await loadTree();
        } catch (e) {
            showError('move', e);
            await loadTree();
        }
    }

    // openMovePicker lists the folders a page or folder can move into.
    function openMovePicker(doc) {
        var list = document.getElementById('move-list');
        document.getElementById('move-title').textContent = 'Move \u201c' + doc.title + '\u201d to\u2026';
        document.getElementById('move-hint').textContent = doc.driveFileId
            ? 'It moves on Google Drive too, so teammates see it in the new folder.'
            : 'It is not published, so it moves on this PC only.';
        var options = [{ id: '', title: 'Top level of the workspace', depth: 0 }];
        (function walk(nodes, depth) {
            (nodes || []).forEach(function (n) {
                var d = n.document;
                if (!d.isFolder || d.id === doc.id) return;          // not into itself (or below it)
                if (depth === 0 && d.title.toLowerCase() === 'assets') return;
                options.push({ id: d.id, title: d.title, depth: depth + 1 });
                walk(n.children, depth + 1);
            });
        })(tree, 0);

        list.innerHTML = '';
        options.forEach(function (o) {
            var b = document.createElement('button');
            b.className = 'move-option';
            b.setAttribute('role', 'option');
            b.style.paddingLeft = (12 + o.depth * 16) + 'px';
            b.textContent = o.title;
            var current = (doc.parentId || '') === o.id;
            if (current) {
                b.disabled = true;
                b.textContent += ' (current)';
            }
            b.addEventListener('click', function () {
                closeMovePicker();
                moveDocument(doc.id, o.id, '');
            });
            list.appendChild(b);
        });
        document.getElementById('move-modal').classList.remove('hidden');
        var first = list.querySelector('.move-option:not([disabled])');
        (first || document.getElementById('btn-close-move')).focus();
    }

    function closeMovePicker() {
        document.getElementById('move-modal').classList.add('hidden');
    }

    // startInlineRename turns a tree item's label into a text field.
    // Enter or leaving the field commits; Esc cancels.
    function startInlineRename(id) {
        var item = document.querySelector('#page-tree .tree-item[data-id="' + cssEscape(id) + '"]');
        var doc = findDoc(id);
        if (!item || !doc) return;
        var label = item.querySelector('.tree-label');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'tree-rename-input';
        input.value = doc.title;
        input.setAttribute('aria-label', 'New name');
        label.replaceWith(input);
        input.focus();
        input.select();

        var done = false;
        function finish(commit) {
            if (done) return;
            done = true;
            var title = input.value.trim();
            if (commit && title && title !== doc.title) {
                renameDocument(doc, title);
            } else {
                renderTree();
            }
        }
        input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });
        input.addEventListener('click', function (e) { e.stopPropagation(); });
        input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    }

    function cssEscape(s) {
        return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
    }

    function toggleFolder(id) {
        if (expandedFolders.has(id)) expandedFolders.delete(id); else expandedFolders.add(id);
        renderTree();
    }

    function updateEmptyState() {
        var has = tree && tree.length > 0;
        document.getElementById('empty-state').classList.toggle('hidden', has || !!currentDocId);
        document.getElementById('editor-container').classList.toggle('hidden', !currentDocId);
    }

    async function selectDocument(id) {
        if (currentDocId === id) return;
        if (currentDocId) await saveNow();
        currentDocId = id;
        try {
            var doc = await window.go.main.App.GetDocument(id);
            document.getElementById('doc-title').value = doc.title;
            loadEditorContent(doc.content);
            // Compare future edits against the serializer's own output, not the
            // raw file: TipTap's markdown round-trip is not byte-identical
            // (blank lines after lists/tables, escaping), so comparing against
            // doc.content would mark untouched pages as modified.
            markClean(doc.title);
            document.getElementById('editor-container').classList.remove('hidden');
            document.getElementById('empty-state').classList.add('hidden');
            window.__hexnoteHasUnsaved = false;
            clearTimeout(saveTimeout);
            saveState = 'saved';
            setDocMeta(doc);
            renderTree();
        } catch (e) { console.error('selectDocument error:', e); }
    }

    async function createDocument(parentID, isFolder) {
        var title = isFolder ? 'New Folder' : 'New Page';
        try {
            var doc = await window.go.main.App.CreateDocument(title, parentID, isFolder);
            if (parentID) expandedFolders.add(parentID);
            await loadTree();
            if (!isFolder) { await selectDocument(doc.id); document.getElementById('doc-title').select(); }
        } catch (e) {
            console.error('createDocument error:', e);
            showError(isFolder ? 'create the folder' : 'create the page', e);
        }
    }

    // findDoc returns the tree's copy of a document, or null.
    function findDoc(id) {
        var found = null;
        (function walk(nodes) {
            (nodes || []).forEach(function (n) {
                if (found) return;
                if (n.document.id === id) found = n.document;
                else walk(n.children);
            });
        })(tree);
        return found;
    }

    // confirmDelete asks before deleting and names what happens on Drive, so
    // nobody is surprised that teammates lose the page too.
    function confirmDelete(doc) {
        if (!doc) return askConfirm('Delete this page?', '', 'Delete', true);
        if (doc.isFolder) {
            return askConfirm(
                'Delete the folder "' + doc.title + '"?',
                doc.driveFileId
                    ? 'Everything in it is deleted from the workspace and the folder moves to the Drive trash. Teammates will no longer see it. The folder owner can restore it from Drive for 30 days.'
                    : 'Everything in it is deleted. Published pages inside move to the Drive trash.',
                'Delete folder', true);
        }
        if (doc.driveFileId) {
            return askConfirm(
                'Delete this page from the workspace and move its Drive file to trash?',
                '"' + doc.title + '" disappears for teammates on their next refresh. The file owner can restore it from the Drive trash for 30 days.',
                'Delete and trash', true);
        }
        return askConfirm('Delete this draft?', '"' + doc.title + '" only exists on this PC, so it cannot be recovered.', 'Delete draft', true);
    }

    // deleteDocument deletes a page or folder after confirmation.
    async function deleteDocument(doc) {
        if (!(await confirmDelete(doc))) return;
        try {
            await window.go.main.App.DeleteDocument(doc.id);
            if (currentDocId === doc.id || (currentDocId && isDescendant(currentDocId, doc.id))) {
                currentDocId = null;
                window.__hexnoteHasUnsaved = false;
                document.getElementById('editor-container').classList.add('hidden');
            }
            await loadTree();
            updateEmptyState();
            showToast('Deleted', 'info');
        } catch (e) {
            console.error('deleteDocument error:', e);
            showError('delete', e);
        }
    }

    // isDescendant reports whether id sits somewhere below ancestorId.
    function isDescendant(id, ancestorId) {
        var d = findDoc(id);
        while (d && d.parentId) {
            if (d.parentId === ancestorId) return true;
            d = findDoc(d.parentId);
        }
        return false;
    }

    async function deleteCurrentDoc() {
        if (!currentDocId) return;
        await deleteDocument(findDoc(currentDocId) || { id: currentDocId, title: '' });
    }

    function onEditorChange() {
        if (!currentDocId) return;
        window.__hexnoteHasUnsaved = true;
        setSaveStatus('unsaved');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveNow, autoSaveDelay);
    }

    function onTitleChange() {
        if (!currentDocId) return;
        window.__hexnoteHasUnsaved = true;
        setSaveStatus('unsaved');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveNow, autoSaveDelay);
    }

    // loadEditorContent shows a page's markdown with a fresh undo history.
    // Without the reset, Ctrl+Z right after opening a page undid the load
    // itself (emptying the page, which autosave then stored) and could replay
    // edits from the previously open page.
    function loadEditorContent(markdown) {
        editor.commands.setContent(markdown || '', { emitUpdate: false });
        var st = editor.state;
        editor.view.updateState(st.constructor.create({ schema: st.schema, doc: st.doc, plugins: st.plugins }));
        refreshToolbar(); // updateState fires no transaction, so the toolbar would not notice
    }

    // editorMarkdown returns the editor content as markdown with a single
    // trailing newline, the conventional ending for a text file on Drive.
    function editorMarkdown() {
        var md = editor.storage.markdown.getMarkdown();
        if (md && md.charAt(md.length - 1) !== '\n') md += '\n';
        return md;
    }

    // markClean records the editor's current state as saved.
    function markClean(title) {
        lastKnownContent = editorMarkdown();
        lastKnownTitle = title;
        window.__hexnoteHasUnsaved = false;
    }

    async function saveNow() {
        if (!currentDocId) return;
        clearTimeout(saveTimeout);
        var title = document.getElementById('doc-title').value.trim() || 'Untitled';
        var content = editorMarkdown();
        // Skip the save only if neither the body nor the title changed since
        // the last load/save. This keeps auto-save from re-dirtying a document
        // that was just updated by sync, without dropping title-only edits.
        if (content === lastKnownContent && title === lastKnownTitle) {
            window.__hexnoteHasUnsaved = false;
            setSaveStatus('saved');
            return;
        }
        setSaveStatus('saving');
        try {
            var doc = await window.go.main.App.UpdateDocument(currentDocId, title, content);
            lastKnownContent = content;
            lastKnownTitle = title;
            window.__hexnoteHasUnsaved = false;
            if (doc && doc.id === currentDocId) currentDocMeta = { status: doc.status, driveFileId: doc.driveFileId || '' };
            setSaveStatus('saved');
            await loadTree();
        } catch (e) { console.error('save error:', errorMessage(e)); setSaveStatus('error'); }
    }

    function setSaveStatus(state) {
        saveState = state;
        renderDocStatus();
    }

    // setDocMeta records the open page's publish state and redraws the header.
    function setDocMeta(doc) {
        currentDocMeta = doc ? { status: doc.status, driveFileId: doc.driveFileId || '' } : null;
        renderDocStatus();
    }

    // renderDocStatus draws the one status line that says where the open page
    // lives, and shows the Publish button when there is something to publish.
    //   Saved on this PC · not published   (draft, never published)
    //   Published · edits not published    (published before, local changes since)
    //   Published · up to date             (Drive has exactly this)
    //   Saving… / Unsaved changes / Couldn't save
    function renderDocStatus() {
        var el = document.getElementById('save-status');
        var btn = document.getElementById('btn-publish');
        var meta = currentDocMeta || { status: 'draft', driveFileId: '' };
        var onDrive = !!meta.driveFileId;
        var pendingEdits = saveState === 'unsaved' || saveState === 'saving';
        var needsPublish = meta.status === 'draft' || pendingEdits;
        var text, cls, tip;

        if (saveState === 'saving') {
            text = 'Saving\u2026'; cls = 'saving'; tip = 'Saving on this PC';
        } else if (saveState === 'unsaved') {
            text = 'Unsaved changes'; cls = 'unsaved'; tip = 'Saved on this PC automatically in a moment (Ctrl+S saves now)';
        } else if (saveState === 'error') {
            text = 'Couldn\u2019t save'; cls = 'error'; tip = 'Saving on this PC failed. Your text is still in the editor; press Ctrl+S to try again.';
        } else if (!onDrive) {
            text = 'Saved on this PC \u00b7 not published'; cls = 'draft';
            tip = 'Only you can see this page. Publish puts it on Google Drive for your team.';
        } else if (meta.status === 'draft') {
            text = 'Published \u00b7 edits not published'; cls = 'modified';
            tip = 'Teammates see the last published version. Publish Changes sends your edits to Google Drive.';
        } else {
            text = 'Published \u00b7 up to date'; cls = 'published';
            tip = 'Google Drive has this version. Teammates see it when they refresh.';
        }
        el.textContent = text;
        el.title = tip;
        el.className = 'save-status ' + cls;

        btn.style.display = needsPublish ? '' : 'none';
        if (!btn.disabled) btn.textContent = onDrive ? 'Publish Changes' : 'Publish';
        btn.title = onDrive ? 'Send your edits to Google Drive (Ctrl+Shift+P)' : 'Put this page on Google Drive for your team (Ctrl+Shift+P)';

        // One-time hint explaining drafts, shown on unpublished pages until dismissed.
        document.getElementById('draft-hint').classList.toggle('hidden', draftHintDismissed || onDrive || !currentDocId);
    }

    async function doSearch() {
        var query = document.getElementById('search-input').value.trim();
        var resultsEl = document.getElementById('search-results');
        if (!query) { resultsEl.classList.add('hidden'); return; }
        try {
            var results = await window.go.main.App.SearchDocuments(query);
            if (!results || results.length === 0) {
                resultsEl.innerHTML = '<div class="search-empty">No results</div>';
            } else {
                resultsEl.innerHTML = results.map(function (r) {
                    // Snippet is pre-sanitized by backend (only <mark> tags allowed)
                    return '<button class="search-result-item" data-id="' + escapeHtml(r.id) + '"><span class="search-result-title">' + escapeHtml(r.title) + '</span><span class="search-result-snippet">' + r.snippet + '</span></button>';
                }).join('');
                resultsEl.querySelectorAll('.search-result-item').forEach(function (item) {
                    item.addEventListener('click', function () {
                        selectDocument(item.dataset.id);
                        document.getElementById('search-input').value = '';
                        resultsEl.classList.add('hidden');
                    });
                });
            }
            resultsEl.classList.remove('hidden');
        } catch (e) { console.error('search error:', e); }
    }

    var contextTarget = null;
    function showContextMenu(e, doc, fromKeyboard) {
        contextTarget = doc;
        var menu = document.getElementById('context-menu');
        menuReturnFocus = fromKeyboard ? document.activeElement : null;
        menu.style.top = e.clientY + 'px';
        menu.style.left = e.clientX + 'px';
        menu.classList.remove('hidden');

        var isRoot = !doc;
        var isFolder = doc && doc.isFolder;

        // New Page/Folder: always visible — creates inside folder, or as sibling for files
        menu.querySelector('[data-action="new-page"]').style.display = '';
        menu.querySelector('[data-action="new-folder"]').style.display = '';
        // Rename/Delete: only show on actual items, not root
        menu.querySelector('[data-action="rename"]').style.display = isRoot ? 'none' : '';
        menu.querySelector('[data-action="move"]').style.display = isRoot ? 'none' : '';
        // Publish: drafts only (a renamed folder is a draft until its name reaches Drive)
        var publishItem = menu.querySelector('[data-action="publish"]');
        var canPublish = !isRoot && doc.status === 'draft';
        publishItem.style.display = canPublish ? '' : 'none';
        publishItem.textContent = (isFolder && doc.driveFileId) ? 'Publish rename' : (doc && doc.driveFileId ? 'Publish changes' : 'Publish');
        keepMenuOnScreen(menu);
        if (fromKeyboard) focusMenu(menu);
        menu.querySelector('[data-action="delete"]').style.display = isRoot ? 'none' : '';
        // Hide the separator if only showing new-page/new-folder
        menu.querySelector('hr').style.display = isRoot ? 'none' : '';
    }

    async function onContextAction(e) {
        var action = e.target.closest('button').dataset.action;
        document.getElementById('context-menu').classList.add('hidden');
        restoreMenuFocus();
        // Determine where to create: inside a folder, as sibling of a file, or at root
        var newParentId = '';
        if (contextTarget) {
            newParentId = contextTarget.isFolder ? contextTarget.id : (contextTarget.parentId || '');
        }
        switch (action) {
            case 'new-page': await createDocument(newParentId, false); break;
            case 'new-folder': await createDocument(newParentId, true); break;
            case 'rename':
                if (!contextTarget) break;
                startInlineRename(contextTarget.id);
                break;
            case 'publish':
                if (!contextTarget) break;
                await publishDocument(contextTarget.id);
                break;
            case 'move':
                if (!contextTarget) break;
                openMovePicker(contextTarget);
                break;
            case 'delete':
                if (!contextTarget) break;
                await deleteDocument(contextTarget);
                break;
        }
        contextTarget = null;
    }

    // === Global Event Binding ===
    // Dialog focus: when a modal opens, focus moves into it (and Tab stays
    // inside); when it closes, focus returns to where it was. Watching the
    // class attribute covers every place that shows or hides a modal.
    function bindModalFocus() {
        var returnTo = {};
        document.querySelectorAll('.modal-overlay').forEach(function (m) {
            if (m.id === 'confirm-sheet') return; // manages its own focus
            new MutationObserver(function () {
                var open = !m.classList.contains('hidden');
                if (open && !returnTo[m.id]) {
                    returnTo[m.id] = document.activeElement || document.body;
                    setTimeout(function () {
                        if (m.contains(document.activeElement)) return; // the opener already focused something
                        var f = focusables(m);
                        var target = f.filter(function (el) { return !el.closest('.modal-header'); })[0] || f[0];
                        if (target) target.focus();
                    }, 0);
                } else if (!open && returnTo[m.id]) {
                    var el = returnTo[m.id];
                    delete returnTo[m.id];
                    if (el && document.body.contains(el) && el.focus) el.focus();
                }
            }).observe(m, { attributes: true, attributeFilter: ['class'] });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') return;
            var open = Array.prototype.slice.call(document.querySelectorAll('.modal-overlay:not(.hidden)'));
            var top = open.filter(function (m) { return m.id === 'confirm-sheet'; })[0] || open[open.length - 1];
            if (!top) return;
            var f = focusables(top);
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    function focusables(root) {
        return Array.prototype.slice.call(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    }

    function bindGlobalEvents() {
        bindSheetEvents();
        bindModalFocus();
        bindCredentialsEvents();
        bindSigninEvents();
        bindPathChoiceEvents();
        bindWorkspacesEvents();
        bindOnboardingEvents();
        bindJoinEvents();
        bindEditorEvents();
        bindSharingEvents();
        bindHistoryEvents();
        bindSettingsEvents();

        // Unsaved-changes warning — prevent accidental data loss
        window.addEventListener('beforeunload', function (e) {
            if (window.__hexnoteHasUnsaved) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    function escapeHtml(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
})();
