import { Permission } from "unix-permissions";
import type { SuperBlock } from "./superblock";
import type {
    DirInode,
    Inode,
    Stat,
    VirtualFileSystem as IVirtualFileSystem,
} from "./interface";
import {
    AlreadyExistsError,
    DirectoryNotEmptyError,
    InternalError,
    IsDirectoryError,
    isError,
    LockedError,
    NotDirectoryError,
    NotFoundError,
} from "./errors";

type Dentry = string;

const ROOT_INDEX = 0;
const LOCK_BACKOFF_MS = 50;
/** 锁等待上限：锁 TTL（30s）+ 余量，确保持锁者崩溃后锁先过期、等待者能拿到而不是超时 */
const LOCK_MAX_WAIT_MS = 35_000;

function parsePath(path: Dentry): string[] {
    return path.split("/").filter(Boolean);
}

/** 业务错误白名单：这些错误原样抛给用户，其余包装为 InternalError */
const BUSINESS_ERRORS = [
    NotFoundError,
    AlreadyExistsError,
    NotDirectoryError,
    IsDirectoryError,
    DirectoryNotEmptyError,
    InternalError,
] as const;

/** 把内部/后端错误统一翻译成业务错误。instanceof 跨 DO RPC 不可靠，用 name 匹配。 */
function translateError(err: unknown): never {
    for (const cls of BUSINESS_ERRORS) {
        if (isError(err, cls)) throw err;
    }
    throw new InternalError(err instanceof Error ? err.message : String(err));
}

export class VirtualFileSystem implements IVirtualFileSystem {
    private mounts = new Map<string, SuperBlock>();

    register_filesystem(b: SuperBlock, path: Dentry): void {
        this.mounts.set(path, b);
    }

    unregister_filesystem(b: SuperBlock): void {
        for (const [path, sb] of this.mounts) {
            if (sb === b) this.mounts.delete(path);
        }
    }

    private superBlock(): SuperBlock {
        const sb = this.mounts.values().next().value;
        if (!sb) throw new InternalError("no filesystem mounted");
        return sb;
    }

    private async resolve(path: Dentry): Promise<Inode> {
        const sb = this.superBlock();
        let current = await sb.getInode(ROOT_INDEX);
        for (const name of parsePath(path)) {
            if (current.kind !== "dir") throw new NotDirectoryError(name);
            const index = current.namespaceOperations.lookup(name);
            if (index === null) throw new NotFoundError(path);
            current = await sb.getInode(index);
        }
        return current;
    }

    private async resolveParent(path: Dentry): Promise<{ parent: DirInode; name: string }> {
        const parts = parsePath(path);
        const name = parts.pop();
        if (name === undefined) throw new NotFoundError(path);
        const parent = await this.resolve("/" + parts.join("/"));
        if (parent.kind !== "dir") throw new NotDirectoryError(path);
        return { parent, name };
    }

    private now(): number {
        return Date.now();
    }

    /** 阻塞等待锁，像 Linux flock；超过 TTL 说明对端崩溃或超长写入，抛 InternalError */
    private async acquireLock(sb: SuperBlock, index: number, owner: string): Promise<void> {
        const deadline = Date.now() + LOCK_MAX_WAIT_MS;
        while (true) {
            try {
                await sb.lock(index, owner);
                return;
            } catch (err) {
                if (isError(err, LockedError)) {
                    if (Date.now() >= deadline) throw new InternalError(`inode ${index} locked`);
                    await new Promise((r) => setTimeout(r, LOCK_BACKOFF_MS));
                    continue;
                }
                translateError(err);
            }
        }
    }

    private async releaseLocks(sb: SuperBlock, indexes: number[], owner: string): Promise<void> {
        for (const idx of indexes.reverse()) {
            try {
                await sb.unlock(idx, owner);
            } catch {
                // 锁可能已过期，忽略
            }
        }
    }

    /** 在锁保护下执行操作 */
    private async withLocks<T>(
        indexes: number[],
        fn: () => Promise<T>,
    ): Promise<T> {
        const sb = this.superBlock();
        const owner = crypto.randomUUID();
        const sorted = [...indexes].sort((a, b) => a - b);

        try {
            for (const idx of sorted) await this.acquireLock(sb, idx, owner);
            try {
                return await fn();
            } catch (err) {
                return translateError(err);
            }
        } finally {
            await this.releaseLocks(sb, sorted, owner);
        }
    }

    userOperations = {
        write: async (path: Dentry, data: Uint8Array): Promise<void> => {
            const sb = this.superBlock();
            const { parent, name } = await this.resolveParent(path);
            const childIndex = parent.namespaceOperations.lookup(name);
            const lockIndexes = childIndex !== null ? [parent.index, childIndex] : [parent.index];

            await this.withLocks(lockIndexes, async () => {
                const freshParent = await sb.getInode<DirInode>(parent.index);
                const existing = freshParent.namespaceOperations.lookup(name);

                if (existing !== null) {
                    const inode = await sb.getInode(existing);
                    if (inode.kind !== "file") throw new IsDirectoryError(path);
                    await inode.AddressSpaceOperations.put(data);
                    inode.size = data.length;
                    inode.modifiedTime = this.now();
                    await sb.writeInode(inode);
                    return;
                }

                const created = await sb.createInode("file", "rw-r--r--");
                await created.AddressSpaceOperations.put(data);
                created.size = data.length;
                await sb.writeInode(created);
                freshParent.namespaceOperations.create(name, created.index);
                freshParent.modifiedTime = this.now();
                await sb.writeInode(freshParent);
            });
        },

        read: async (path: Dentry): Promise<Uint8Array> => {
            const inode = await this.resolve(path);
            if (inode.kind !== "file") throw new IsDirectoryError(path);
            return inode.AddressSpaceOperations.read();
        },

        mkdir: async (path: Dentry): Promise<void> => {
            const sb = this.superBlock();
            const { parent, name } = await this.resolveParent(path);

            await this.withLocks([parent.index], async () => {
                const freshParent = await sb.getInode<DirInode>(parent.index);
                if (freshParent.namespaceOperations.lookup(name) !== null) {
                    throw new AlreadyExistsError(path);
                }
                const created = await sb.createInode("dir", "rwxr-xr-x");
                freshParent.namespaceOperations.create(name, created.index);
                freshParent.modifiedTime = this.now();
                await sb.writeInode(freshParent);
            });
        },

        remove: async (path: Dentry): Promise<void> => {
            const sb = this.superBlock();
            const { parent, name } = await this.resolveParent(path);
            const childIndex = parent.namespaceOperations.lookup(name);
            const lockIndexes = childIndex !== null ? [parent.index, childIndex] : [parent.index];

            await this.withLocks(lockIndexes, async () => {
                const freshParent = await sb.getInode<DirInode>(parent.index);
                const index = freshParent.namespaceOperations.lookup(name);
                if (index === null) throw new NotFoundError(path);
                const inode = await sb.getInode(index);
                if (inode.kind === "dir" && inode.namespace.size > 0) {
                    throw new DirectoryNotEmptyError(path);
                }
                freshParent.namespaceOperations.delete(name);
                freshParent.modifiedTime = this.now();
                await sb.writeInode(freshParent);
            });
        },

        move: async (from: Dentry, to: Dentry): Promise<void> => {
            if (from === to) return;
            const sb = this.superBlock();
            const src = await this.resolveParent(from);
            const dst = await this.resolveParent(to);

            {
                const srcIndex = src.parent.namespaceOperations.lookup(src.name);
                if (srcIndex !== null) {
                    const srcInode = await sb.getInode(srcIndex);
                    const normalizedFrom = from.replace(/\/+$/, "");
                    if (srcInode.kind === "dir" && (to === normalizedFrom || to.startsWith(normalizedFrom + "/"))) {
                        throw new IsDirectoryError("cannot move directory into itself");
                    }
                }
            }

            await this.withLocks([src.parent.index, dst.parent.index], async () => {
                const freshSrc = await sb.getInode<DirInode>(src.parent.index);
                const freshDst =
                    dst.parent.index === src.parent.index
                        ? freshSrc
                        : (await sb.getInode<DirInode>(dst.parent.index));

                const index = freshSrc.namespaceOperations.lookup(src.name);
                if (index === null) throw new NotFoundError(from);

                const existing = freshDst.namespaceOperations.lookup(dst.name);
                if (existing === index) {
                    freshSrc.namespaceOperations.delete(src.name);
                    freshSrc.modifiedTime = this.now();
                    await sb.writeInode(freshSrc);
                    return;
                }
                if (existing !== null) throw new AlreadyExistsError(to);

                freshDst.namespaceOperations.create(dst.name, index);
                freshDst.modifiedTime = this.now();
                await sb.writeInode(freshDst);

                freshSrc.namespaceOperations.delete(src.name);
                freshSrc.modifiedTime = this.now();
                await sb.writeInode(freshSrc);
            });
        },

        list: async (path: Dentry): Promise<Dentry[]> => {
            const inode = await this.resolve(path);
            if (inode.kind !== "dir") throw new NotDirectoryError(path);
            return [...inode.namespace.keys()];
        },

        stat: async (path: Dentry): Promise<Stat> => {
            const inode = await this.resolve(path);
            return {
                kind: inode.kind,
                size: inode.size,
                permission: inode.permission,
                modifiedTime: inode.modifiedTime,
            };
        },

        chmod: async (path: Dentry, mode: Permission): Promise<void> => {
            const sb = this.superBlock();
            const inode = await this.resolve(path);

            await this.withLocks([inode.index], async () => {
                const fresh = await sb.getInode(inode.index);
                fresh.permission = mode;
                fresh.modifiedTime = this.now();
                await sb.writeInode(fresh);
            });
        },

        getXAttr: async (path: Dentry, key: string): Promise<string | null> => {
            const inode = await this.resolve(path);
            return inode.inodeOperations.getXAttr(key);
        },

        setXAttr: async (path: Dentry, key: string, value: string): Promise<void> => {
            const sb = this.superBlock();
            const inode = await this.resolve(path);

            await this.withLocks([inode.index], async () => {
                const fresh = await sb.getInode(inode.index);
                fresh.inodeOperations.setXAttr(key, value);
                await sb.writeInode(fresh);
            });
        },

        listXAttrs: async (path: Dentry): Promise<Record<string, string>> => {
            const inode = await this.resolve(path);
            return Object.fromEntries(inode.inodeOperations.listXAttr());
        },
    };
}
