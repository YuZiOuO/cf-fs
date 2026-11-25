#!/usr/bin/env bun

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  password,
  outro,
  spinner,
  text,
} from "@clack/prompts";
import { execa } from "execa";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const configPath = "wrangler.jsonc";
const defaults = {
  workerName: "cf-fs",
  bucketName: "webdav",
  username: "admin",
} as const;

type WorkerVersion = {
  id: string;
};

type WorkerVersionDetails = {
  resources?: {
    bindings?: { type?: string; bucket_name?: string }[];
  };
};

const runWrangler = (args: string[], input?: string, interactive = false) =>
  execa("bunx", ["wrangler", ...args], {
    input,
    stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
  });

const authenticate = async () => {
  const auth = spinner();
  auth.start("正在检查 Wrangler 登录状态 / Checking Wrangler authentication");
  try {
    const result = await runWrangler(["whoami", "--json"]);
    const status = JSON.parse(result.stdout ?? "") as { loggedIn?: boolean };
    if (!status.loggedIn) throw new Error("Wrangler is not logged in");
    auth.stop("Wrangler 登录状态有效 / Wrangler authentication confirmed");
  } catch {
    auth.stop("正在启动 Cloudflare 登录 / Starting Cloudflare login");
    await runWrangler(["login", "--browser=false"], undefined, true);
  }
};

const destroy = async () => {
  intro("cf-fs destruction");
  const workerNameValue = await text({
    message: "Worker name",
    initialValue: "",
  });
  if (isCancel(workerNameValue)) {
    cancel("操作已取消 / Operation cancelled.");
    process.exit(0);
  }
  const workerName = workerNameValue.trim();
  let bucketName: string | undefined;
  try {
    const versions = JSON.parse(
      (await runWrangler(["versions", "list", "--name", workerName, "--json"]))
        .stdout ?? "",
    ) as WorkerVersion[];
    const latest = versions[0];
    if (latest) {
      const details = JSON.parse(
        (
          await runWrangler([
            "versions",
            "view",
            latest.id,
            "--name",
            workerName,
            "--json",
          ])
        ).stdout ?? "",
      ) as WorkerVersionDetails;
      bucketName = details.resources?.bindings?.find(
        (binding) => binding.type === "r2_bucket" && binding.bucket_name,
      )?.bucket_name;
    }
  } catch (error) {
    log.error(
      `Unable to find or inspect Worker ${workerName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    outro("Destruction stopped.");
    return;
  }

  log.error(`Danger: deleting Worker ${workerName} cannot be undone.`);
  const deleteWorker = await confirm({
    message: `Delete Worker ${workerName}?`,
    active: "Delete",
    inactive: "Keep",
    initialValue: false,
  });
  if (isCancel(deleteWorker) || !deleteWorker) {
    outro("Destruction cancelled.");
    return;
  }

  const worker = spinner();
  worker.start(`Deleting Worker ${workerName}`);
  await runWrangler(["delete", workerName]);
  worker.stop(`Deleted Worker ${workerName}`);

  if (!bucketName) {
    outro("Worker deleted. No R2 bucket binding was found.");
    return;
  }
  log.error(
    `Danger: deleting R2 bucket ${bucketName} permanently deletes all stored objects.`,
  );
  const deleteBucket = await confirm({
    message: `Delete R2 bucket ${bucketName} and all objects in it?`,
    active: "Delete",
    inactive: "Keep",
    initialValue: false,
  });
  if (isCancel(deleteBucket) || !deleteBucket) {
    outro(`Worker deleted. R2 bucket ${bucketName} was kept.`);
    return;
  }

  const bucket = spinner();
  bucket.start(`Deleting R2 bucket ${bucketName}`);
  await runWrangler(["r2", "bucket", "delete", bucketName]);
  bucket.stop(`Deleted R2 bucket ${bucketName}`);
  outro("Destruction complete.");
};

const main = async () => {
  const command = process.argv[2];
  if (command === "destroy") {
    await destroy();
    return;
  }
  if (command !== "deploy") {
    console.error("Usage: cf-fs <deploy|destroy>");
    process.exitCode = 1;
    return;
  }

  intro("部署 cf-fs / Deploy cf-fs");
  await authenticate();
  const config = await readFile(
    fileURLToPath(new URL("../wrangler.jsonc", import.meta.url).href),
    "utf8",
  );
  const workerNameValue = await text({
    message: "请输入 Worker 名称 / Enter the Worker name",
    initialValue:
      config.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? defaults.workerName,
  });
  if (isCancel(workerNameValue)) {
    cancel("操作已取消 / Operation cancelled.");
    process.exit(0);
  }
  const workerName = workerNameValue.trim();
  try {
    const versions = JSON.parse(
      (await runWrangler(["versions", "list", "--name", workerName, "--json"]))
        .stdout ?? "",
    ) as WorkerVersion[];
    if (versions.length > 0) {
      log.error(
        `Worker ${workerName} 已存在 / Worker ${workerName} already exists.`,
      );
      outro(
        "请使用 destroy 命令清理后再部署 / Run bunx cf-fs destroy before deploying again.",
      );
      return;
    }
  } catch {
    // Wrangler reports a missing Worker as a failed versions query.
  }
  const bucketNameValue = await text({
    message: "请输入 R2 bucket 名称 / Enter the R2 bucket name",
    initialValue:
      config.match(/"bucket_name"\s*:\s*"([^"]+)"/)?.[1] ?? defaults.bucketName,
  });
  if (isCancel(bucketNameValue)) {
    cancel("操作已取消 / Operation cancelled.");
    process.exit(0);
  }
  const bucketName = bucketNameValue.trim();
  const usernameValue = await text({
    message: "请输入 WebDAV 用户名 / Enter the WebDAV username",
    initialValue: defaults.username,
  });
  if (isCancel(usernameValue)) {
    cancel("操作已取消 / Operation cancelled.");
    process.exit(0);
  }
  const username = usernameValue.trim();
  const passwordValue = await password({
    message: "请输入 WebDAV 密码 / Enter the WebDAV password",
    validate: (value) =>
      value ? undefined : "密码不能为空 / Password cannot be empty",
  });
  if (isCancel(passwordValue)) {
    cancel("部署已取消 / Deployment cancelled.");
    return;
  }

  const updatedConfig = [
    ["name", workerName],
    ["bucket_name", bucketName],
    ["main", fileURLToPath(new URL("../src/index.ts", import.meta.url).href)],
  ].reduce((result, [key, value]) => {
    const pattern = new RegExp(`(\\"${key}\\"\\s*:\\s*)\\"[^\\"]*\\"`);
    if (!pattern.test(result))
      throw new Error(`Unable to find ${key} in ${configPath}`);
    return result.replace(pattern, `$1${JSON.stringify(value)}`);
  }, config);
  await writeFile(configPath, updatedConfig);

  const storage = spinner();
  storage.start(
    `正在创建或复用 R2 bucket ${bucketName} / Creating or reusing R2 bucket ${bucketName}`,
  );
  let bucketStatus: "created" | "existing";
  try {
    await runWrangler(["r2", "bucket", "info", bucketName, "--json"]);
    bucketStatus = "existing";
  } catch {
    await runWrangler(["r2", "bucket", "create", bucketName]);
    bucketStatus = "created";
  }
  storage.stop(
    bucketStatus === "created"
      ? `已创建 R2 bucket ${bucketName} / Created R2 bucket ${bucketName}`
      : `正在使用已有 R2 bucket ${bucketName} / Using existing R2 bucket ${bucketName}`,
  );

  const secrets = spinner();
  secrets.start("正在设置 Worker 密钥 / Setting Worker secrets");
  await runWrangler(
    ["secret", "put", "USERNAME", "--name", workerName],
    `${username}\n`,
  );
  await runWrangler(
    ["secret", "put", "PASSWORD", "--name", workerName],
    `${passwordValue}\n`,
  );
  secrets.stop("Worker 密钥设置完成 / Worker secrets configured");

  const deployment = spinner();
  deployment.start("正在部署 Worker / Deploying Worker");
  const deployed = await runWrangler([
    "deploy",
    "--config",
    configPath,
    "--name",
    workerName,
    "--minify",
  ]);
  deployment.stop("Worker 部署完成 / Worker deployed");
  const url = (deployed.stdout ?? "").match(/https:\/\/[^\s)]+/)?.[0];
  outro(
    url
      ? `部署完成，访问地址：${url} / Deployment complete: ${url}`
      : "部署完成 / Deployment complete.",
  );
};

try {
  await main();
} catch (error) {
  cancel(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
