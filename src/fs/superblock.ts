import type { Inode, SuperBlock as ISuperBlock } from "./interface";
import type { FileSystemState } from "./durable-object";
import { AlreadyExistsError, NotFoundError } from "./errors";
import { Permission } from "unix-permissions";

type InodeIndex = number;

/** 可序列化的 inode 元数据，DO 存储格式 */
export type InodeRecord = {
    index: InodeIndex;
    kind: "file" | "dir";
    size: number;
    permission: Permission;
    accessTime: number;
    modifiedTime: number;
    xattrs: Record<string, string>;
    namespace?: Record<string, number>;
};

function makeInodeOperations(xattrs: Map<string, string>) {
    return {
        getXAttr: (key: string) => xattrs.get(key) ?? null,
        setXAttr: (key: string, value: string) => {
            const replaced = xattrs.has(key);
            xattrs.set(key, value);
            return replaced;
        },
        listXAttr: () => new Map(xattrs),
    };
}

/** R2 内容 key，GC 与读写路径共用，改数据布局只动这里 */
export function contentKey(index: InodeIndex): string {
    return `content/${index}`;
}

function makeAddressSpace(bucket: R2Bucket, index: InodeIndex) {
    const key = contentKey(index);
    return {
        read: async (): Promise<Uint8Array> => {
            const obj = await bucket.get(key);
            if (!obj) return new Uint8Array(0);
            return new Uint8Array(await obj.arrayBuffer());
        },
        put: async (data: Uint8Array): Promise<void> => {
            await bucket.put(key, data);
        },
    };
}

/**
 * 元数据访问入口：通过 RPC 调用 Durable Object。
 * 每次操作返回新物化的 inode 对象；内容 I/O 由 AddressSpaceOperations 直读直写 R2。
 */
export class SuperBlock implements ISuperBlock {
    constructor(
        private state: DurableObjectStub<FileSystemState>,
        private bucket: R2Bucket,
    ) {}

    private materialize(record: InodeRecord): Inode {
        const base = {
            index: record.index,
            size: record.size,
            permission: record.permission,
            accessTime: record.accessTime,
            modifiedTime: record.modifiedTime,
            inodeOperations: makeInodeOperations(new Map(Object.entries(record.xattrs))),
        };

        if (record.kind === "file") {
            return {
                ...base,
                kind: "file",
                AddressSpaceOperations: makeAddressSpace(this.bucket, record.index),
            };
        }

        const namespace = new Map<string, number>(Object.entries(record.namespace ?? {}));
        return {
            ...base,
            kind: "dir",
            namespace,
            namespaceOperations: {
                lookup: (name) => namespace.get(name) ?? null,
                create: (dentry, inode) => {
                    if (namespace.has(dentry)) throw new AlreadyExistsError(dentry);
                    namespace.set(dentry, inode);
                },
                delete: (dentry) => {
                    if (!namespace.delete(dentry)) throw new NotFoundError(dentry);
                },
            },
        };
    }

    private toRecord(inode: Inode): InodeRecord {
        const record: InodeRecord = {
            index: inode.index,
            kind: inode.kind,
            size: inode.size,
            permission: inode.permission,
            accessTime: inode.accessTime,
            modifiedTime: inode.modifiedTime,
            xattrs: Object.fromEntries(inode.inodeOperations.listXAttr()),
        };
        if (inode.kind === "dir") {
            record.namespace = Object.fromEntries(inode.namespace);
        }
        return record;
    }

    async createInode<K extends Inode["kind"]>(
        kind: K,
        permission: Permission,
    ): Promise<Extract<Inode, { kind: K }>> {
        const now = Date.now();
        const record = await this.state.allocate({
            kind,
            size: 0,
            permission,
            accessTime: now,
            modifiedTime: now,
            xattrs: {},
            ...(kind === "dir" ? { namespace: {} } : {}),
        });
        return this.materialize(record) as Extract<Inode, { kind: K }>;
    }

    async getInode<T extends Inode = Inode>(i: InodeIndex): Promise<T> {
        return this.materialize(await this.state.get(i)) as T;
    }

    async writeInode(i: Inode): Promise<void> {
        await this.state.write(this.toRecord(i));
    }

    async lock(index: InodeIndex, owner: string): Promise<void> {
        await this.state.lock(index, owner);
    }

    async unlock(index: InodeIndex, owner: string): Promise<void> {
        await this.state.unlock(index, owner);
    }
}
