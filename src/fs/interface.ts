import { Permission } from "unix-permissions";

export type InodeIndex = number;
export type Dentry = string;

export type InodeBase = {
    index: InodeIndex;
    size: number;
    permission: Permission;
    accessTime: number;
    modifiedTime: number;
    inodeOperations: {
        getXAttr(key: string): string | null;
        setXAttr(key: string, value: string): boolean;
        listXAttr(): Map<string, string>;
    };
};

export interface FileInode extends InodeBase {
    readonly kind: "file";
    AddressSpaceOperations: {
        read(): Promise<ReadableStream<Uint8Array>>;
        put(data: ReadableStream<Uint8Array>): Promise<number>;
    };
}

export interface DirInode extends InodeBase {
    readonly kind: "dir";
    namespace: Map<Dentry, InodeIndex>; // hack: this was a suggested impl, init here for implmentation simplcity
    namespaceOperations: {
        lookup(name: Dentry): InodeIndex | null;
        create(dentry: Dentry, inode: InodeIndex): void;
        delete(dentry: Dentry): void;
    };
}

export type Inode = FileInode | DirInode;

export interface Stat {
    kind: Inode["kind"];
    size: number;
    permission: Permission;
    modifiedTime: number;
}

export interface SuperBlock {
    createInode<K extends Inode["kind"]>(kind: K, permission: Permission): Promise<Extract<Inode, { kind: K }>>;
    getInode(i: InodeIndex): Promise<Inode>;
    writeInode(i: Inode): Promise<void>;
}

export interface VirtualFileSystem {
    register_filesystem(b: SuperBlock, path: Dentry): void;
    unregister_filesystem(b: SuperBlock): void;

    userOperations: {
        write(path: Dentry, data: ReadableStream<Uint8Array>): Promise<void>;
        read(path: Dentry): Promise<ReadableStream<Uint8Array>>;
        mkdir(path: Dentry): Promise<void>;
        remove(path: Dentry): Promise<void>;
        move(from: Dentry, to: Dentry): Promise<void>;
        list(path: Dentry): Promise<Dentry[]>;
        stat(path: Dentry): Promise<Stat>;
        chmod(path: Dentry, mode: Permission): Promise<void>;
        getXAttr(path: Dentry, key: string): Promise<string | null>;
        setXAttr(path: Dentry, key: string, value: string): Promise<void>;
        listXAttrs(path: Dentry): Promise<Record<string, string>>;
    };
}
