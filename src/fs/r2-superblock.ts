import { DurableObject } from "cloudflare:workers";
import type { Inode, SuperBlock as ISuperBlock } from "./interface";
import { AlreadyExistsError, NotFoundError, rethrow } from "./errors";
import { Permission } from "unix-permissions";

const ROOT_INDEX = 0;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type InodeRow = {
    idx: number;
    kind: "file" | "dir";
    size: number;
    permission: Permission;
    accessTime: number;
    modifiedTime: number;
    xattrs: string;
    namespace: string | null;
};

export class R2SuperBlockState extends DurableObject {
    constructor(ctx: DurableObjectState, env: CloudflareBindings) {
        super(ctx, env);
        void this.ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS inodes (
                    idx INTEGER PRIMARY KEY,
                    kind TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    permission TEXT NOT NULL,
                    accessTime INTEGER NOT NULL,
                    modifiedTime INTEGER NOT NULL,
                    xattrs TEXT NOT NULL,
                    namespace TEXT
                )
            `);
            const root = this.ctx.storage.sql.exec(`SELECT idx FROM inodes WHERE idx = ?`, ROOT_INDEX).toArray();
            if (root.length === 0) {
                const now = Date.now();
                this.ctx.storage.sql.exec(
                    `INSERT INTO inodes (idx, kind, size, permission, accessTime, modifiedTime, xattrs, namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    ROOT_INDEX, "dir", 0, "rwxr-xr-x", now, now, "{}", "{}"
                );
            }
            const alarm = await this.ctx.storage.getAlarm();
            if (alarm === null) {
                await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
            }
        });
    }

    allocate(kind: "file" | "dir", permission: Permission): InodeRow {
        const now = Date.now();
        this.ctx.storage.sql.exec(
            `INSERT INTO inodes (kind, size, permission, accessTime, modifiedTime, xattrs, namespace) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            kind, 0, permission, now, now, "{}", kind === "dir" ? "{}" : null
        );
        const result = this.ctx.storage.sql.exec(`SELECT last_insert_rowid() as idx`).toArray()[0];
        return this.get(result.idx as number)!;
    }

    get(idx: number): InodeRow | null {
        const result = this.ctx.storage.sql.exec(`SELECT * FROM inodes WHERE idx = ?`, idx).toArray();
        return (result[0] as InodeRow | undefined) ?? null;
    }

    write(inode: InodeRow): void {
        this.ctx.storage.sql.exec(
            `UPDATE inodes SET kind = ?, size = ?, permission = ?, accessTime = ?, modifiedTime = ?, xattrs = ?, namespace = ? WHERE idx = ?`,
            inode.kind, inode.size, inode.permission, inode.accessTime, inode.modifiedTime, inode.xattrs, inode.namespace, inode.idx
        );
    }

    async alarm(): Promise<void> {
        await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);

        const reachableRows = this.ctx.storage.sql.exec(`
            WITH RECURSIVE reachable(idx) AS (
                SELECT ?
                UNION
                SELECT json_each.value
                FROM reachable
                JOIN inodes ON inodes.idx = reachable.idx
                JOIN json_each(inodes.namespace)
                WHERE inodes.kind = 'dir'
            )
            SELECT idx FROM reachable
        `, ROOT_INDEX).toArray();
        const reachable = new Set(reachableRows.map((row) => row.idx as number));

        const allRows = this.ctx.storage.sql.exec(`SELECT idx FROM inodes`).toArray();
        const garbage = allRows.map((row) => row.idx as number).filter((idx) => !reachable.has(idx));

        if (garbage.length > 0) {
            const r2Keys = garbage.map((idx) => `content/${idx}`);
            for (let i = 0; i < r2Keys.length; i += 1000) {
                await this.env.BUCKET.delete(r2Keys.slice(i, i + 1000));
            }
            for (let i = 0; i < garbage.length; i += 100) {
                const batch = garbage.slice(i, i + 100);
                const placeholders = batch.map(() => "?").join(",");
                this.ctx.storage.sql.exec(`DELETE FROM inodes WHERE idx IN (${placeholders})`, ...batch);
            }
        }

        await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
}

export class R2SuperBlock implements ISuperBlock {
    constructor(
        private state: DurableObjectStub<R2SuperBlockState>,
        private bucket: R2Bucket,
    ) {}

    async createInode<K extends Inode["kind"]>(
        kind: K,
        permission: Permission,
    ): Promise<Extract<Inode, { kind: K }>> {
        try {
            const record = await this.state.allocate(kind, permission);
            return this.materialize(record) as Extract<Inode, { kind: K }>;
        } catch (err) {
            rethrow(err);
        }
    }

    async getInode(i: number): Promise<Inode> {
        try {
            const record = await this.state.get(i);
            if (!record) throw new NotFoundError(`inode ${i}`);
            return this.materialize(record);
        } catch (err) {
            rethrow(err);
        }
    }

    async writeInode(i: Inode): Promise<void> {
        try {
            await this.state.write({
                idx: i.index,
                kind: i.kind,
                size: i.size,
                permission: i.permission,
                accessTime: i.accessTime,
                modifiedTime: i.modifiedTime,
                xattrs: JSON.stringify(Object.fromEntries(i.inodeOperations.listXAttr())),
                namespace: i.kind === "dir" ? JSON.stringify(Object.fromEntries(i.namespace)) : null,
            });
        } catch (err) {
            rethrow(err);
        }
    }

    private materialize(record: InodeRow): Inode {
        const xattrs = new Map<string, string>(Object.entries(JSON.parse(record.xattrs)));
        const base = {
            index: record.idx,
            size: record.size,
            permission: record.permission,
            accessTime: record.accessTime,
            modifiedTime: record.modifiedTime,
            inodeOperations: {
                getXAttr: (key: string) => xattrs.get(key) ?? null,
                setXAttr: (key: string, value: string) => {
                    const replaced = xattrs.has(key);
                    xattrs.set(key, value);
                    return replaced;
                },
                listXAttr: () => new Map(xattrs),
            },
        };

        if (record.kind === "file") {
            const key = `content/${record.idx}`;
            return {
                ...base,
                kind: "file",
                AddressSpaceOperations: {
                    read: async () => {
                        const obj = await this.bucket.get(key);
                        if (!obj) return new Uint8Array(0);
                        return new Uint8Array(await obj.arrayBuffer());
                    },
                    put: async (data: Uint8Array) => {
                        await this.bucket.put(key, data);
                    },
                },
            };
        }

        const namespace = new Map<string, number>(Object.entries(JSON.parse(record.namespace ?? "{}")));
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
}
