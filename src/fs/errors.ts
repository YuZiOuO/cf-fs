export class FsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
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

const classes = [
  NotFoundError,
  AlreadyExistsError,
  NotDirectoryError,
  IsDirectoryError,
  DirectoryNotEmptyError,
  InternalError,
];

/**
 * Cloudflare RPC 跨边界序列化丢失原型链，instanceof 不可靠，但 name 保留。
 * 按 name 重建为本地类实例，使 instanceof 恢复可用。
 */
export function rethrow(err: unknown): never {
  if (err instanceof Error) {
    for (const cls of classes) {
      if (err.name === cls.name) throw new cls(err.message);
    }
  }
  throw err;
}
