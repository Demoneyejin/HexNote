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
        cancel.focus();
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

    function bindSheetEvents() {
        var sheet = document.getElementById('confirm-sheet');
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
        grid.innerHTML = workspaces.map(function (ws) {
            var synced = ws.lastSyncedAt ? 'Last synced: ' + new Date(ws.lastSyncedAt).toLocaleString() : 'Never synced';
            return '<div class="workspace-card" data-id="' + ws.id + '" data-name="' + escapeHtml(ws.name) + '">' +
                '<div class="workspace-card-body">' +
                '<h3>' + escapeHtml(ws.name) + '</h3>' +
                '<p class="workspace-meta">' + synced + '</p>' +
                '</div>' +
                '<button class="ws-menu-btn" data-id="' + ws.id + '" data-name="' + escapeHtml(ws.name) + '" title="Options">\u22EE</button>' +
                '</div>';
        }).join('');

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

    var wsContextTargetId = null;
    var wsContextTargetName = null;

    function showWsContextMenu(e, wsId, wsName) {
        wsContextTargetId = wsId;
        wsContextTargetName = wsName;
        var menu = document.getElementById('ws-context-menu');
        menu.style.top = e.clientY + 'px';
        menu.style.left = e.clientX + 'px';
        menu.classList.remove('hidden');

        var isCard = !!wsId;
        menu.querySelector('[data-action="ws-open"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-rename"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-permissions"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-delete"]').style.display = isCard ? '' : 'none';
        menu.querySelector('[data-action="ws-new"]').style.display = isCard ? 'none' : '';
        var sep = menu.querySelector('hr');
        if (sep) sep.style.display = isCard ? '' : 'none';
    }

    async function onWsContextAction(e) {
        var action = e.target.dataset.action;
        document.getElementById('ws-context-menu').classList.add('hidden');
        switch (action) {
            case 'ws-open':
                if (wsContextTargetId) openWorkspace(wsContextTargetId);
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
            extensions: [
                TipTap.StarterKit,
                TipTap.Image.configure({ inline: false, allowBase64: false, HTMLAttributes: { draggable: 'true' } }),
                TipTap.Placeholder.configure({ placeholder: 'Start writing...' }),
                TipTap.Table.configure({ resizable: true }),
                TipTap.TableRow,
                TipTap.TableCell,
                TipTap.TableHeader,
                TipTap.TaskList,
                TipTap.TaskItem.configure({ nested: true }),
                TipTap.Link.configure({ openOnClick: false }),
                TipTap.Markdown,
            ],
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

        var groups = [
            [
                { label: 'H1', cmd: function () { editor.chain().focus().toggleHeading({ level: 1 }).run(); }, active: function () { return editor.isActive('heading', { level: 1 }); } },
                { label: 'H2', cmd: function () { editor.chain().focus().toggleHeading({ level: 2 }).run(); }, active: function () { return editor.isActive('heading', { level: 2 }); } },
                { label: 'H3', cmd: function () { editor.chain().focus().toggleHeading({ level: 3 }).run(); }, active: function () { return editor.isActive('heading', { level: 3 }); } },
            ],
            [
                { label: 'B', cmd: function () { editor.chain().focus().toggleBold().run(); }, active: function () { return editor.isActive('bold'); }, style: 'font-weight:bold' },
                { label: 'I', cmd: function () { editor.chain().focus().toggleItalic().run(); }, active: function () { return editor.isActive('italic'); }, style: 'font-style:italic' },
                { label: 'S', cmd: function () { editor.chain().focus().toggleStrike().run(); }, active: function () { return editor.isActive('strike'); }, style: 'text-decoration:line-through' },
                { label: '<>', cmd: function () { editor.chain().focus().toggleCode().run(); }, active: function () { return editor.isActive('code'); } },
            ],
            [
                { label: '\u2014', title: 'Horizontal Rule', cmd: function () { editor.chain().focus().setHorizontalRule().run(); } },
                { label: '\u201C', title: 'Blockquote', cmd: function () { editor.chain().focus().toggleBlockquote().run(); }, active: function () { return editor.isActive('blockquote'); } },
            ],
            [
                { label: '\u2022', title: 'Bullet List', cmd: function () { editor.chain().focus().toggleBulletList().run(); }, active: function () { return editor.isActive('bulletList'); } },
                { label: '1.', title: 'Ordered List', cmd: function () { editor.chain().focus().toggleOrderedList().run(); }, active: function () { return editor.isActive('orderedList'); } },
                { label: '\u2611', title: 'Task List', cmd: function () { editor.chain().focus().toggleTaskList().run(); }, active: function () { return editor.isActive('taskList'); } },
            ],
            [
                { label: '\u229E', title: 'Table', cmd: function () { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
                {
                    label: '\uD83D\uDDBC', title: 'Image', cmd: function () {
                        var input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.onchange = function () { if (input.files[0]) uploadAndInsertImage(input.files[0]); };
                        input.click();
                    }
                },
            ],
            [
                { label: '{}', title: 'Code Block', cmd: function () { editor.chain().focus().toggleCodeBlock().run(); }, active: function () { return editor.isActive('codeBlock'); } },
            ],
        ];

        groups.forEach(function (group, gi) {
            if (gi > 0) {
                var sep = document.createElement('span');
                sep.className = 'toolbar-sep';
                toolbar.appendChild(sep);
            }
            group.forEach(function (btn) {
                var el = document.createElement('button');
                el.className = 'toolbar-btn';
                el.textContent = btn.label;
                el.title = btn.title || btn.label;
                if (btn.style) el.setAttribute('style', btn.style);
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
                    if (buttons[idx]) {
                        if (btn.active && btn.active()) {
                            buttons[idx].classList.add('active');
                        } else {
                            buttons[idx].classList.remove('active');
                        }
                    }
                    idx++;
                });
            });
        }
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
            // Double-click or F2 renames in place.
            pageTreeEl.addEventListener('dblclick', function (e) {
                var item = e.target.closest('.tree-item');
                if (!item || e.target.closest('.tree-toggle')) return;
                e.preventDefault();
                startInlineRename(item.dataset.id);
            });
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
        editor.commands.setContent(doc.content || '', { emitUpdate: false });
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
                    (m.role !== 'owner' ? '<button class="btn-icon btn-danger member-remove" data-email="' + escapeHtml(m.email) + '">&times;</button>' : '') +
                    '</div>';
            }).join('');

            listEl.querySelectorAll('.member-remove').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    await window.go.main.App.RemoveWorkspaceMember(activeWorkspace.id, btn.dataset.email);
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
                listEl.innerHTML = '<p class="history-empty">No version history available. Sync to Drive first to enable version tracking.</p>';
                return;
            }
            listEl.innerHTML = revisions.map(function (r) {
                var date = new Date(r.modifiedTime).toLocaleString();
                var user = r.lastModifyingUser || 'Unknown';
                var sizeKB = Math.round((r.size || 0) / 1024);
                return '<button class="history-item" data-rev="' + r.revisionId + '">' +
                    '<span class="history-item-date">' + date + '</span>' +
                    '<span class="history-item-user">' + escapeHtml(user) + '</span>' +
                    '<span class="history-item-size">' + sizeKB + ' KB</span>' +
                    '</button>';
            }).join('');

            listEl.querySelectorAll('.history-item').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    listEl.querySelectorAll('.history-item').forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    selectedRevisionId = btn.dataset.rev;
                    previewEl.classList.remove('hidden');
                    document.getElementById('history-preview-date').textContent = btn.querySelector('.history-item-date').textContent;
                    document.getElementById('history-preview-content').textContent = 'Loading...';
                    try {
                        var content = await window.go.main.App.PreviewRevision(currentDocId, selectedRevisionId);
                        document.getElementById('history-preview-content').textContent = content;
                    } catch (e) {
                        console.error('PreviewRevision:', errorMessage(e));
                        document.getElementById('history-preview-content').textContent = describeError(e, 'load this version').text;
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
            if (!(await askConfirm('Restore this version?',
                'The page text is replaced with the version from ' + when + '. The restored text is saved on this PC as unpublished changes until you publish it.',
                'Restore'))) return;
            try {
                var doc = await window.go.main.App.RestoreVersion(currentDocId, selectedRevisionId);
                editor.commands.setContent(doc.content || '', { emitUpdate: false });
                document.getElementById('doc-title').value = doc.title;
                markClean(doc.title);
                document.getElementById('history-modal').classList.add('hidden');
                setDocMeta(doc);
                setSaveStatus('saved');
                showToast('Version restored', 'success');
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
        pageTree.innerHTML = '';
        if (!tree || tree.length === 0) return;
        tree.forEach(function (node) {
            // Hide the "assets" folder — it's an internal folder for image storage
            if (node.document.isFolder && node.document.title.toLowerCase() === 'assets') return;
            pageTree.appendChild(renderNode(node, 0));
        });
    }

    function renderNode(node, depth) {
        var doc = node.document;
        var el = document.createElement('div');
        el.className = 'tree-item' + (doc.id === currentDocId ? ' selected' : '');
        el.dataset.id = doc.id;
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

        var container = document.createElement('div');
        container.className = 'tree-node';
        container.appendChild(el);

        if (doc.isFolder && isExpanded && node.children) {
            var childDiv = document.createElement('div');
            childDiv.className = 'tree-children';
            node.children.forEach(function (child) { childDiv.appendChild(renderNode(child, depth + 1)); });
            container.appendChild(childDiv);
        }
        return container;
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
            editor.commands.setContent(doc.content || '', { emitUpdate: false });
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
    function showContextMenu(e, doc) {
        contextTarget = doc;
        var menu = document.getElementById('context-menu');
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
        // Publish: drafts only (a renamed folder is a draft until its name reaches Drive)
        var publishItem = menu.querySelector('[data-action="publish"]');
        var canPublish = !isRoot && doc.status === 'draft';
        publishItem.style.display = canPublish ? '' : 'none';
        publishItem.textContent = (isFolder && doc.driveFileId) ? 'Publish rename' : (doc && doc.driveFileId ? 'Publish changes' : 'Publish');
        menu.querySelector('[data-action="delete"]').style.display = isRoot ? 'none' : '';
        // Hide the separator if only showing new-page/new-folder
        menu.querySelector('hr').style.display = isRoot ? 'none' : '';
    }

    async function onContextAction(e) {
        var action = e.target.dataset.action;
        document.getElementById('context-menu').classList.add('hidden');
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
            case 'delete':
                if (!contextTarget) break;
                await deleteDocument(contextTarget);
                break;
        }
        contextTarget = null;
    }

    // === Global Event Binding ===
    function bindGlobalEvents() {
        bindSheetEvents();
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
