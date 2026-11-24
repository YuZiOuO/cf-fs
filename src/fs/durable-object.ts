import { DurableObject } from "cloudflare:workers";
import type { InodeRecord } from "./superblock";
import { contentKey } from "./superblock";
import { LockedError, NotFoundError, NotLockedError } from "./errors";

const ROOT_INDEX = 0;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 锁内包含 R2 大文件写入时，TTL 必须大于最坏写入时长。
// 当前无续期机制，30s 是保守下限；若写入可能超过该值，应加大或改为心跳续期。
const LOCK_TTL_MS = 30_000;

type LockState = { owner: string; expires: number };

const INODE_PREFIX = "inode:";
function inodeKey(index: number): string {
    return `${INODE_PREFIX}${index}`;
}

/**
 * 文件系统元数据状态。
 * 单线程 + input gates：连续的存储读改写天然互斥，无需额外锁。
 * 提供通用存储原语与锁；alarm() 的对账需要遍历 namespace 字段计算可达性，
 * 这是 reconcile 的固有职责（跨 DO 元数据 + R2 内容），无法下推到纯存储原语。
 */
export class FileSystemState extends DurableObject {
    constructor(ctx: DurableObjectState, env: CloudflareBindings) {
        super(ctx, env);
        this.ctx.blockConcurrencyWhile(async () => {
            await this.ensureRoot();
            await this.scheduleReconcile();
        });
    }

    private async scheduleReconcile(): Promise<void> {
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) {
            await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
        }
    }

    private async nextIndex(): Promise<number> {
        const current = (await this.ctx.storage.get<number>("nextIndex")) ?? ROOT_INDEX + 1;
        await this.ctx.storage.put("nextIndex", current + 1);
        return current;
    }

    async ensureRoot(): Promise<void> {
        const existing = await this.ctx.storage.get<InodeRecord>(inodeKey(ROOT_INDEX));
        if (existing) return;
        const now = Date.now();
        await this.ctx.storage.put(inodeKey(ROOT_INDEX), {
            index: ROOT_INDEX,
            kind: "dir",
            size: 0,
            permission: "rwxr-xr-x",
            accessTime: now,
            modifiedTime: now,
            xattrs: {},
            namespace: {},
        } satisfies InodeRecord);
        await this.ctx.storage.put("nextIndex", ROOT_INDEX + 1);
    }

    async allocate(template: Omit<InodeRecord, "index">): Promise<InodeRecord> {
        const index = await this.nextIndex();
        const record: InodeRecord = { ...template, index };
        await this.ctx.storage.put(inodeKey(index), record);
        return record;
    }

    async get(index: number): Promise<InodeRecord> {
        const record = await this.ctx.storage.get<InodeRecord>(inodeKey(index));
        if (!record) throw new NotFoundError(`inode ${index}`);
        return record;
    }

    async write(record: InodeRecord): Promise<void> {
        const existing = await this.ctx.storage.get<InodeRecord>(inodeKey(record.index));
        if (!existing) throw new NotFoundError(`inode ${record.index}`);
        await this.ctx.storage.put(inodeKey(record.index), record);
    }

    private async acquireLockKey(key: string, owner: string, ttl: number): Promise<void> {
        const existing = await this.ctx.storage.get<LockState>(key);
        const now = Date.now();
        if (existing && existing.expires > now && existing.owner !== owner) {
            throw new LockedError(`${key} is locked`);
        }
        await this.ctx.storage.put(key, { owner, expires: now + ttl } satisfies LockState);
    }

    private async releaseLockKey(key: string, owner: string): Promise<void> {
        const existing = await this.ctx.storage.get<LockState>(key);
        if (!existing || existing.owner !== owner) {
            throw new NotLockedError(key);
        }
        await this.ctx.storage.delete(key);
    }

    async lock(index: number, owner: string): Promise<void> {
        await this.acquireLockKey(`lock:${index}`, owner, LOCK_TTL_MS);
    }

    async unlock(index: number, owner: string): Promise<void> {
        await this.releaseLockKey(`lock:${index}`, owner);
    }

    /** 每日对账：遍历自身存储找出不可达记录，删除 DO 记录和 R2 内容 */
    async alarm(): Promise<void> {
        // 无论成败都先重设下一次 alarm：CF 内建重试上限 6 次，耗尽后若不重设，
        // 对账链会永久停摆直到 DO 重启，违反"每日一次"的回收意图。
        // 成功路径末尾会再次 setAlarm（覆盖为从完成时刻起算的 24h）。
        await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);

        // 一次 list 全量取出，值直接用于可达性遍历，省掉逐条 get
        const allRecords = new Map<number, InodeRecord>();
        let startAfter: string | undefined;
        while (true) {
            const page = await this.ctx.storage.list<InodeRecord>({
                prefix: INODE_PREFIX,
                startAfter,
                limit: 1000,
            });
            for (const [key, record] of page) {
                allRecords.set(Number(key.slice(INODE_PREFIX.length)), record);
            }
            if (page.size < 1000) break;
            startAfter = [...page.keys()].pop();
        }

        // 从 root 遍历 namespace 字段，收集可达集合
        const reachable = new Set<number>();
        const stack = [ROOT_INDEX];
        while (stack.length > 0) {
            const index = stack.pop()!;
            if (reachable.has(index)) continue;
            const record = allRecords.get(index);
            if (!record) continue;
            reachable.add(index);
            if (record.kind === "dir" && record.namespace) {
                for (const child of Object.values(record.namespace)) {
                    stack.push(child);
                }
            }
        }

        const garbage = [...allRecords.keys()].filter((i) => !reachable.has(i));

        // 先删 R2 内容（幂等，≤1000/次），再删 DO 记录（含残留 lock key，≤128/次）。
        // 顺序重要：可达性遍历以 DO 记录为依据，若先删 DO 记录、崩溃后再删 R2，
        // 残留的 R2 对象将失去对应记录、永远无法被后续对账发现（永久孤儿）。
        // 反过来崩溃只留下"无内容的不可达 DO 记录"，下次对账可正常清理。
        if (garbage.length > 0) {
            const bucket = this.env.BUCKET;
            const r2Keys = garbage.map(contentKey);
            for (let i = 0; i < r2Keys.length; i += 1000) {
                await bucket.delete(r2Keys.slice(i, i + 1000));
            }
            const doKeys = garbage.flatMap((i) => [inodeKey(i), `lock:${i}`]);
            for (let i = 0; i < doKeys.length; i += 128) {
                await this.ctx.storage.delete(doKeys.slice(i, i + 128));
            }
        }
        // 成功才重设 24h；失败则靠 CF alarm 的内建重试（2s 退避，6 次），
        // 不在这里吞掉异常，避免瞬时故障静默跳过一次对账。
        await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
}
