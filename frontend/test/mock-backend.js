// Stateful stand-in for the Wails Go backend, injected into the page before
// app.js runs. It mirrors the semantics of app.go closely enough for UI tests:
// editing a page turns it into a draft, publishing marks it published, delete
// is recursive, and so on. Every call is recorded in window.__S.calls.
//
// Tests control it through window.__S:
//   __S.fail[name] = 'ERR_OFFLINE: ...'   next call to `name` rejects (once)
//   __S.fail[name] = { error: '...', persist: true }   rejects every time
//   __S.override[name] = function (...args) { ... }    replaces the method
//   window.runtime.EventsEmit(name, data)              simulates a Go event
(function () {
    'use strict';

    var seed = window.__HEXNOTE_SEED || {};
    var idCounter = 1000;
    function newId() { return 'id-' + (idCounter++); }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function nowIso() { return new Date().toISOString(); }

    var S = window.__S = {
        calls: [],
        fail: {},
        override: {},
        listeners: {},
        opened: [],
        auth: Object.assign({ hasCredentials: true, isSignedIn: true, userEmail: 'alex@example.com', mode: 'team', bundledAvailable: false }, seed.auth || {}),
        settings: Object.assign({ syncIntervalSecs: 120, theme: 'light', autoSaveDelaySecs: 1 }, seed.settings || {}),
        workspaces: clone(seed.workspaces) || [
            { id: 'ws-1', name: 'Studio Wiki', driveFolderId: 'drive-root-1', driveFolderUrl: 'https://drive.google.com/drive/folders/drive-root-1', lastSyncedAt: null, isActive: false, access: 'owner' },
        ],
        docs: {},
        members: clone(seed.members) || [
            { id: 'm1', workspaceId: 'ws-1', email: 'alex@example.com', role: 'owner', displayName: 'Alex', permissionId: 'p1' },
            { id: 'm2', workspaceId: 'ws-1', email: 'sam@example.com', role: 'writer', displayName: 'Sam', permissionId: 'p2' },
        ],
        revisions: clone(seed.revisions) || {},
        ui: clone(seed.ui) || {},
        syncResult: [],          // doc IDs TriggerSync reports as updated
        syncMutations: null,     // optional function run inside TriggerSync
    };

    (seed.docs || []).forEach(function (d, i) {
        S.docs[d.id] = Object.assign({
            content: '', parentId: '', isFolder: false, status: 'draft', driveFileId: '',
            sortOrder: i, workspaceId: 'ws-1', isDirty: d.status !== 'published',
            createdAt: nowIso(), updatedAt: nowIso(),
        }, clone(d));
    });

    function activeWs() {
        for (var i = 0; i < S.workspaces.length; i++) if (S.workspaces[i].isActive) return S.workspaces[i];
        return null;
    }

    function requireDoc(id) {
        var d = S.docs[id];
        if (!d) throw 'ERR_NOTFOUND: document not found';
        return d;
    }

    function descendants(id) {
        var out = [];
        Object.keys(S.docs).forEach(function (k) {
            if (S.docs[k].parentId === id) { out.push(k); out = out.concat(descendants(k)); }
        });
        return out;
    }

    function buildTree() {
        var ws = activeWs();
        var list = Object.keys(S.docs).map(function (k) { return S.docs[k]; })
            .filter(function (d) { return !ws || d.workspaceId === ws.id; })
            .sort(function (a, b) { return a.sortOrder - b.sortOrder; });
        var nodes = {};
        list.forEach(function (d) { nodes[d.id] = { document: clone(d), children: null }; });
        var roots = [];
        list.forEach(function (d) {
            var n = nodes[d.id];
            if (d.parentId && nodes[d.parentId]) {
                var p = nodes[d.parentId];
                (p.children = p.children || []).push(n);
            } else {
                roots.push(n);
            }
        });
        return roots;
    }

    var impl = {
        // --- settings / auth ---
        GetSettings: function () { return clone(S.settings); },
        UpdateSettings: function (sync, theme, autosave) {
            if (sync < 0) sync = 0;
            S.settings = { syncIntervalSecs: sync, theme: theme, autoSaveDelaySecs: autosave };
            return clone(S.settings);
        },
        GetAuthStatus: function () { return clone(S.auth); },
        ImportCredentials: function () { S.auth.hasCredentials = true; S.auth.mode = 'team'; return null; },
        UseBundledCredentials: function () { S.auth.hasCredentials = true; S.auth.mode = 'solo'; return null; },
        StartOAuthFlow: function () { return null; },
        OnAuthComplete: function () { S.auth.isSignedIn = true; return clone(S.auth); },
        SignOut: function () { S.auth.isSignedIn = false; return null; },
        ClearCredentials: function () { S.auth.hasCredentials = false; S.auth.isSignedIn = false; return null; },

        // --- workspaces ---
        GetWorkspaces: function () { return clone(S.workspaces); },
        GetActiveWorkspace: function () { return clone(activeWs()); },
        CreateWorkspace: function (name, folderId) {
            var ws = { id: newId(), name: name, driveFolderId: folderId, driveFolderUrl: 'https://drive.google.com/drive/folders/' + folderId, lastSyncedAt: null, isActive: false, access: 'owner' };
            S.workspaces.push(ws);
            return impl.SwitchWorkspace(ws.id);
        },
        CreateSoloWorkspace: function (name) { return impl.CreateWorkspace(name, 'auto-' + newId()); },
        SwitchWorkspace: function (id) {
            S.workspaces.forEach(function (w) { w.isActive = w.id === id; });
            return clone(activeWs());
        },
        DeleteWorkspace: function (id) {
            S.workspaces = S.workspaces.filter(function (w) { return w.id !== id; });
            return null;
        },
        RenameWorkspace: function (id, name) {
            S.workspaces.forEach(function (w) { if (w.id === id) w.name = name; });
            return null;
        },
        ListDriveFolders: function () { return [{ id: 'f1', name: 'Projects' }, { id: 'f2', name: 'Docs' }]; },
        CreateDriveFolder: function (name) { return { id: newId(), name: name }; },
        SearchSharedFolders: function () { return [{ id: 'sf1', name: 'Team Wiki' }]; },
        ResolveFolderLink: function () { return { id: 'sf2', name: 'Linked Folder' }; },

        // --- documents ---
        CreateDocument: function (title, parentId, isFolder) {
            var ws = activeWs();
            var d = { id: newId(), title: title, content: '', parentId: parentId || '', isFolder: !!isFolder, status: 'draft', driveFileId: '', sortOrder: Object.keys(S.docs).length, workspaceId: ws ? ws.id : '', isDirty: true, createdAt: nowIso(), updatedAt: nowIso() };
            S.docs[d.id] = d;
            return clone(d);
        },
        GetDocument: function (id) { return clone(requireDoc(id)); },
        UpdateDocument: function (id, title, content) {
            var d = requireDoc(id);
            d.title = title; d.content = content; d.status = 'draft'; d.isDirty = true; d.updatedAt = nowIso();
            return clone(d);
        },
        RenameDocument: function (id, title) {
            var d = requireDoc(id);
            d.title = title;
            if (d.isFolder && d.driveFileId) {
                // Published folders push the rename at once unless offline.
                d.status = S.offline ? 'draft' : 'published';
            } else if (!d.isFolder) {
                d.status = 'draft';
            }
            return clone(d);
        },
        DeleteDocument: function (id) {
            requireDoc(id);
            descendants(id).concat([id]).forEach(function (k) { delete S.docs[k]; });
            return null;
        },
        MoveDocument: function (id, newParentId) {
            var d = requireDoc(id);
            if (newParentId && descendants(id).concat([id]).indexOf(newParentId) >= 0) throw 'cannot move a folder into itself';
            d.parentId = newParentId || '';
            d.sortOrder = Object.keys(S.docs).length + 100;
            return null;
        },
        MoveDocumentTo: function (id, newParentId, beforeId) {
            var d = requireDoc(id);
            if (newParentId && descendants(id).concat([id]).indexOf(newParentId) >= 0) throw 'ERR_INVALID: A folder cannot be moved into itself.';
            d.parentId = newParentId || '';
            var sibs = Object.keys(S.docs).map(function (k) { return S.docs[k]; })
                .filter(function (x) { return (x.parentId || '') === (newParentId || '') && x.id !== id; })
                .sort(function (a, b) { return a.sortOrder - b.sortOrder; });
            var ordered = [];
            sibs.forEach(function (x) { if (x.id === beforeId) ordered.push(d); ordered.push(x); });
            if (ordered.indexOf(d) < 0) ordered.push(d);
            ordered.forEach(function (x, i) { x.sortOrder = i; });
            if (S.offline && d.driveFileId) d.status = 'draft';
            return clone(d);
        },
        GetDocumentTree: function () { return buildTree(); },
        SearchDocuments: function (q) {
            q = (q || '').toLowerCase();
            return Object.keys(S.docs).map(function (k) { return S.docs[k]; })
                .filter(function (d) { return !d.isFolder && (d.title + ' ' + d.content).toLowerCase().indexOf(q) >= 0; })
                .map(function (d) { return { id: d.id, title: d.title, snippet: '<mark>' + q + '</mark>' }; });
        },

        // --- sync / publish ---
        TriggerSync: function () {
            if (S.syncMutations) S.syncMutations(S);
            var ids = S.syncResult.slice();
            S.syncResult = [];
            var ws = activeWs();
            if (ws) ws.lastSyncedAt = nowIso();
            if (ids.length) emit('sync:docs-updated', ids);
            return { updated: ids, removed: [], detached: [] };
        },
        PublishDocument: function (id) {
            var d = requireDoc(id);
            d.status = 'published'; d.isDirty = false;
            if (!d.driveFileId) d.driveFileId = 'drv-' + d.id;
            d.driveModifiedAt = nowIso();
            return clone(d);
        },
        ForcePublishDocument: function (id) { return impl.PublishDocument(id); },
        DiscardLocalChanges: function (id) {
            var d = requireDoc(id);
            if (S.remoteContent && S.remoteContent[id] != null) d.content = S.remoteContent[id];
            d.status = 'published'; d.isDirty = false;
            return clone(d);
        },
        KeepBothVersions: function (id) {
            var d = requireDoc(id);
            var copy = impl.CreateDocument(d.title + ' (my version)', d.parentId, false);
            S.docs[copy.id].content = d.content;
            impl.DiscardLocalChanges(id);
            return clone(S.docs[copy.id]);
        },
        GetSyncStatus: function () { return { state: 'idle', message: 'Up to date' }; },

        // --- sharing ---
        ShareWorkspace: function (wsId, email, role) {
            S.members.push({ id: newId(), workspaceId: wsId, email: email, role: role, displayName: '', permissionId: newId() });
            return null;
        },
        GetWorkspaceMembers: function (wsId) { return clone(S.members.filter(function (m) { return m.workspaceId === wsId; })); },
        RemoveWorkspaceMember: function (wsId, email) {
            S.members = S.members.filter(function (m) { return !(m.workspaceId === wsId && m.email === email); });
            return null;
        },

        // --- version history ---
        GetVersionHistory: function (id) { return clone(S.revisions[id] || []); },
        PreviewRevision: function (id, rev) {
            var list = S.revisions[id] || [];
            for (var i = 0; i < list.length; i++) if (list[i].revisionId === rev) return list[i].content || '';
            throw 'ERR_NOTFOUND: revision not found';
        },
        RestoreVersion: function (id, rev) {
            var content = impl.PreviewRevision(id, rev);
            var d = requireDoc(id);
            var res = {};
            if (d.status === 'draft' && d.content !== content) {
                var b = impl.CreateDocument(d.title + ' (before restore)', d.parentId, false);
                S.docs[b.id].content = d.content;
                res.backupId = b.id; res.backupTitle = b.title;
            }
            d.content = content; d.status = 'draft';
            res.document = clone(d);
            return res;
        },

        // --- UI state ---
        GetUIState: function (key) { return (S.ui || {})[key] || ''; },
        SetUIState: function (key, value) { S.ui = S.ui || {}; S.ui[key] = value; return null; },

        // --- misc ---
        ExportWorkspace: function () { return '/tmp/export'; },
        UploadImage: function (b64, name) { var ws = activeWs(); return '/images/' + (ws ? ws.id : 'x') + '/img-' + name; },
        DumpLogs: function () { return '/tmp/frontend.log'; },
    };

    function emit(name, data) {
        (S.listeners[name] || []).forEach(function (cb) { cb(data); });
    }

    var App = {};
    Object.keys(impl).forEach(function (name) {
        App[name] = function () {
            var args = Array.prototype.slice.call(arguments);
            S.calls.push({ name: name, args: clone(args) });
            var f = S.fail[name];
            if (f) {
                if (!f.persist) delete S.fail[name];
                return Promise.reject(typeof f === 'string' ? f : f.error);
            }
            try {
                var fn = S.override[name] || impl[name];
                return Promise.resolve(fn.apply(null, args));
            } catch (e) {
                return Promise.reject(e);
            }
        };
    });

    window.go = { main: { App: App } };
    window.runtime = {
        EventsOn: function (name, cb) { (S.listeners[name] = S.listeners[name] || []).push(cb); return function () {}; },
        EventsEmit: emit,
        BrowserOpenURL: function (url) { S.opened.push(url); },
    };
})();
