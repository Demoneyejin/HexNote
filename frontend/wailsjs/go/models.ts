export namespace models {

	export interface AuthStatus {
	    hasCredentials: boolean;
	    isSignedIn: boolean;
	    userEmail?: string;
	    sessionExpired?: boolean;
	    offline?: boolean;
	    mode?: string;
	    bundledAvailable?: boolean;
	}

	export interface Document {
	    id: string;
	    title: string;
	    content: string;
	    parentId: string;
	    workspaceId?: string;
	    driveFileId?: string;
	    sortOrder: number;
	    isFolder: boolean;
	    isDirty: boolean;
	    status: string;
	    createdAt: any;
	    updatedAt: any;
	    driveModifiedAt?: any;
	}

	export interface DriveFolder {
	    id: string;
	    name: string;
	    parentId?: string;
	}

	export interface Label {
	    id: string;
	    name: string;
	    color: string;
	}

	export interface RestoreResult {
	    document: models.Document;
	    backupId?: string;
	    backupTitle?: string;
	}

	export interface Revision {
	    revisionId: string;
	    modifiedTime: string;
	    size: number;
	    lastModifyingUser?: string;
	}

	export interface SearchResult {
	    id: string;
	    title: string;
	    snippet: string;
	}

	export interface Settings {
	    syncIntervalSecs: number;
	    theme: string;
	    autoSaveDelaySecs: number;
	}

	export interface SyncStatus {
	    state: string;
	    message: string;
	    lastSynced?: any;
	}

	export interface SyncSummary {
	    updated: Array<string>;
	    removed: Array<string>;
	    detached: Array<string>;
	}

	export interface TreeNode {
	    document: models.Document;
	    children: Array<models.TreeNode>;
	}

	export interface Workspace {
	    id: string;
	    name: string;
	    driveFolderId: string;
	    driveFolderUrl: string;
	    lastSyncedAt?: any;
	    createdAt: any;
	    isActive: boolean;
	    access?: string;
	}

	export interface WorkspaceMember {
	    id: string;
	    workspaceId: string;
	    email: string;
	    role: string;
	    displayName: string;
	    permissionId: string;
	}

}
