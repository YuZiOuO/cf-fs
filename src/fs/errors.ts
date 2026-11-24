export class FsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * RPC 安全的错误判定。
 * Cloudflare DO RPC 跨边界序列化会丢失原型链，instanceof 不可靠；
 * 但 name 属性会被保留（构造函数里 new.target.name），所以用 name 匹配。
 */
export function isError(err: unknown, cls: new (...args: never[]) => FsError): boolean {
    return err instanceof Error && err.name === cls.name;
}

/** 业务错误：路径不存在 */
export class NotFoundError extends FsError {}
/** 业务错误：目标已存在 */
export class AlreadyExistsError extends FsError {}
/** 业务错误：不是目录 */
export class NotDirectoryError extends FsError {}
/** 业务错误：是目录，预期文件 */
export class IsDirectoryError extends FsError {}
/** 业务错误：目录非空 */
export class DirectoryNotEmptyError extends FsError {}
/** 内部错误：非预期的系统级失败 */
export class InternalError extends FsError {}
