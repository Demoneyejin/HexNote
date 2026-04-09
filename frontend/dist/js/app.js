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
    var lastKnownContent = '';  // tracks the last content loaded/saved to DB — prevents auto-save from re-dirtying unchanged docs

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
    function showToast(message, type, durationMs) {
        type = type || 'info';
        durationMs = durationMs || 4000;
        var container = document.getElementById('toast-container');
        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(function () { toast.classList.add('toast-visible'); });
        setTimeout(function () {
            toast.classList.remove('toast-visible');
            toast.addEventListener('transitionend', function () { toast.remove(); });
        }, durationMs);
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
            }
        } catch (e) { /* ignore — settings not critical for boot */ }

        updateEditorDarkMode();
        await routeToCorrectView();
    }

    async function routeToCorrectView() {
        try {
            var status = await window.go.main.App.GetAuthStatus();

            if (!status.hasCredentials) {
                showView('view-credentials');
                return;
            }
            if (!status.isSignedIn) {
                showView('view-signin');
                return;
            }

            // Signed in — show user email everywhere
            var email = status.userEmail || '';
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
                showView('view-signin');
            } catch (e) {
                errEl.textContent = 'Error: ' + (e.message || e);
                errEl.classList.remove('hidden');
            }
        });

        document.getElementById('link-gcp').addEventListener('click', function (e) {
            e.preventDefault();
            if (window.runtime) window.runtime.BrowserOpenURL('https://console.cloud.google.com/apis/credentials');
        });
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
                errEl.textContent = 'Error: ' + (e.message || e);
                errEl.classList.remove('hidden');
                waitEl.classList.add('hidden');
            }
        });

        // Advanced: let power users provide their own OAuth credentials
        document.getElementById('btn-custom-credentials').addEventListener('click', function () {
            showView('view-credentials');
        });

        // Listen for auth completion from Wails event
        if (window.runtime) {
            window.runtime.EventsOn('auth:complete', async function () {
                await window.go.main.App.OnAuthComplete();
                await routeToCorrectView();
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
            });

            // Refresh tree when sync pulls new published pages
            window.runtime.EventsOn('sync:docs-updated', function () {
                loadTree();
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
                var newName = prompt('Rename workspace:', wsContextTargetName);
                if (newName && newName.trim()) {
                    await window.go.main.App.RenameWorkspace(wsContextTargetId, newName.trim());
                    var ws = await window.go.main.App.GetWorkspaces();
                    showWorkspacesView(ws);
                }
                break;
            case 'ws-delete':
                if (!wsContextTargetId) break;
                if (confirm('Delete workspace "' + wsContextTargetName + '"? Local data will be removed. Google Drive folder is not affected.')) {
                    await window.go.main.App.DeleteWorkspace(wsContextTargetId);
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
        await window.go.main.App.SignOut();
        showView('view-signin');
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
            triggerSync();
        } catch (e) {
            console.error('Open workspace error:', e);
            showToast('Failed to open workspace', 'error');
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
                showToast('Error creating folder: ' + (e.message || e), 'error');
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
                showToast('Error creating workspace: ' + (e.message || e), 'error');
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
                resultEl.textContent = 'Error: ' + (e.message || e);
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
                showToast('Error joining workspace: ' + (e.message || e), 'error');
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
            listEl.innerHTML = '<div class="folder-empty">Error loading shared folders: ' + escapeHtml(e.message || String(e)) + '</div>';
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
            listEl.innerHTML = '<div class="folder-empty">Error loading folders: ' + escapeHtml(e.message || String(e)) + '</div>';
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
                    showToast('Image upload failed: ' + (e.message || e), 'error');
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

        document.getElementById('btn-sync').addEventListener('click', triggerSync);
        document.getElementById('btn-publish').addEventListener('click', publishCurrentDoc);

        document.getElementById('btn-share').addEventListener('click', function () {
            document.getElementById('sharing-modal').classList.remove('hidden');
            loadMembers();
        });

        document.getElementById('btn-history').addEventListener('click', openVersionHistory);
    }

    // === Sync & Publish ===
    async function triggerSync() {
        var syncBtn = document.getElementById('btn-sync');
        var statusEl = document.getElementById('sync-status-text');
        syncBtn.classList.add('syncing');
        statusEl.textContent = 'Refreshing...';
        try {
            await window.go.main.App.TriggerSync();
            statusEl.textContent = 'Up to date';
            showToast('Refreshed from Drive', 'success');
            await loadTree();
        } catch (e) {
            statusEl.textContent = 'Refresh error';
            showToast('Refresh failed: ' + (e.message || e), 'error');
        } finally {
            syncBtn.classList.remove('syncing');
        }
    }

    async function publishCurrentDoc() {
        if (!currentDocId) return;
        await saveNow();
        var btn = document.getElementById('btn-publish');
        btn.disabled = true;
        btn.textContent = 'Publishing...';
        try {
            var doc = await window.go.main.App.PublishDocument(currentDocId);
            showToast('Published to Drive', 'success');
            btn.style.display = 'none';
            await loadTree();
        } catch (e) {
            showToast('Publish failed: ' + (e.message || e), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Publish';
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
                showToast('Error sharing: ' + (e.message || e), 'error');
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
                        document.getElementById('history-preview-content').textContent = 'Error loading revision: ' + (e.message || e);
                    }
                });
            });
        } catch (e) {
            listEl.innerHTML = '<p class="history-empty">' + escapeHtml(e.message || 'Error loading history') + '</p>';
        }
    }

    function bindHistoryEvents() {
        document.getElementById('btn-close-history').addEventListener('click', function () {
            document.getElementById('history-modal').classList.add('hidden');
        });

        document.getElementById('btn-restore-version').addEventListener('click', async function () {
            if (!currentDocId || !selectedRevisionId) return;
            if (!confirm('Restore this version? Your current content will be replaced.')) return;
            try {
                var doc = await window.go.main.App.RestoreVersion(currentDocId, selectedRevisionId);
                editor.commands.setContent(doc.content || '');
                document.getElementById('doc-title').value = doc.title;
                document.getElementById('history-modal').classList.add('hidden');
                showToast('Version restored', 'success');
                setSaveStatus('Saved');
            } catch (e) {
                showToast('Error restoring version: ' + (e.message || e), 'error');
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
                document.getElementById('settings-modal').classList.remove('hidden');
            } catch (e) {
                showToast('Error loading settings', 'error');
            }
        });

        document.getElementById('btn-close-settings').addEventListener('click', function () {
            document.getElementById('settings-modal').classList.add('hidden');
        });

        document.getElementById('btn-save-settings').addEventListener('click', async function () {
            var theme = document.getElementById('setting-theme').value;
            var autosave = parseInt(document.getElementById('setting-autosave').value) || 2;
            try {
                await window.go.main.App.UpdateSettings(0, theme, autosave);
                applyTheme(theme);
                autoSaveDelay = autosave * 1000;
                document.getElementById('settings-modal').classList.add('hidden');
                showToast('Settings saved', 'success');
            } catch (e) {
                showToast('Error saving settings: ' + (e.message || e), 'error');
            }
        });

        document.getElementById('btn-export-workspace').addEventListener('click', async function () {
            try {
                var path = await window.go.main.App.ExportWorkspace();
                showToast('Exported to: ' + path, 'success', 6000);
            } catch (e) {
                if (e.message && e.message.indexOf('no folder selected') >= 0) return; // user cancelled
                showToast('Export failed: ' + (e.message || e), 'error');
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
        if (!doc.isFolder) {
            if (doc.status === 'draft' && doc.driveFileId) {
                statusBadge = '<span class="tree-badge badge-modified" title="Unpublished changes">Modified</span>';
            } else if (doc.status === 'draft') {
                statusBadge = '<span class="tree-badge badge-draft" title="Draft">Draft</span>';
            }
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
            lastKnownContent = doc.content || '';
            editor.commands.setContent(lastKnownContent);
            document.getElementById('editor-container').classList.remove('hidden');
            document.getElementById('empty-state').classList.add('hidden');
            window.__hexnoteHasUnsaved = false;
            clearTimeout(saveTimeout);
            setSaveStatus('Saved');
            // Show publish button for draft documents
            var publishBtn = document.getElementById('btn-publish');
            if (doc.status === 'draft') {
                publishBtn.style.display = '';
                publishBtn.textContent = doc.driveFileId ? 'Publish Changes' : 'Publish';
            } else {
                publishBtn.style.display = 'none';
            }
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
            showToast('Error creating document', 'error');
        }
    }

    async function deleteCurrentDoc() {
        if (!currentDocId) return;
        if (!confirm('Delete this page? This cannot be undone.')) return;
        try {
            await window.go.main.App.DeleteDocument(currentDocId);
            currentDocId = null;
            document.getElementById('editor-container').classList.add('hidden');
            await loadTree();
            updateEmptyState();
            showToast('Deleted', 'info');
        } catch (e) {
            console.error('deleteCurrentDoc error:', e);
            showToast('Error deleting document', 'error');
        }
    }

    function onEditorChange() {
        if (!currentDocId) return;
        window.__hexnoteHasUnsaved = true;
        setSaveStatus('Unsaved');
        // Show publish button immediately on first edit — don't wait for save
        var publishBtn = document.getElementById('btn-publish');
        if (publishBtn && publishBtn.style.display === 'none') {
            publishBtn.style.display = '';
            publishBtn.textContent = 'Publish Changes';
        }
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveNow, autoSaveDelay);
    }

    function onTitleChange() {
        if (!currentDocId) return;
        setSaveStatus('Unsaved');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveNow, autoSaveDelay);
    }

    async function saveNow() {
        if (!currentDocId) return;
        clearTimeout(saveTimeout);
        var title = document.getElementById('doc-title').value.trim() || 'Untitled';
        var content = editor.storage.markdown.getMarkdown();
        // Skip the save if content hasn't actually changed from what we loaded/last saved.
        // This prevents auto-save from re-dirtying a document that was just updated by sync.
        if (content.trim() === lastKnownContent.trim()) {
            window.__hexnoteHasUnsaved = false;
            setSaveStatus('Saved');
            return;
        }
        setSaveStatus('Saving...');
        try {
            var doc = await window.go.main.App.UpdateDocument(currentDocId, title, content);
            lastKnownContent = content;
            window.__hexnoteHasUnsaved = false;
            setSaveStatus('Saved');
            // Editing sets status to 'draft' — show the Publish button
            var publishBtn = document.getElementById('btn-publish');
            if (doc && doc.status === 'draft') {
                publishBtn.style.display = '';
                publishBtn.textContent = doc.driveFileId ? 'Publish Changes' : 'Publish';
            }
            await loadTree();
        } catch (e) { console.error('save error:', e); setSaveStatus('Error'); }
    }

    function setSaveStatus(text) {
        var el = document.getElementById('save-status');
        el.textContent = text;
        var cls = 'save-status';
        if (text === 'Saved') cls += ' saved';
        else if (text === 'Error') cls += ' error';
        else if (text === 'Saving...') cls += ' saving';
        else if (text === 'Unsaved') cls += ' unsaved';
        el.className = cls;
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
                var newTitle = prompt('Rename:', contextTarget.title);
                if (newTitle && newTitle.trim()) {
                    await window.go.main.App.UpdateDocument(contextTarget.id, newTitle.trim(), contextTarget.content || '');
                    if (currentDocId === contextTarget.id) document.getElementById('doc-title').value = newTitle.trim();
                    await loadTree();
                }
                break;
            case 'delete':
                if (!contextTarget) break;
                if (confirm('Delete "' + contextTarget.title + '"?')) {
                    await window.go.main.App.DeleteDocument(contextTarget.id);
                    if (currentDocId === contextTarget.id) { currentDocId = null; document.getElementById('editor-container').classList.add('hidden'); }
                    await loadTree();
                    updateEmptyState();
                }
                break;
        }
        contextTarget = null;
    }

    // === Global Event Binding ===
    function bindGlobalEvents() {
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
