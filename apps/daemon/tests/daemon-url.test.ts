import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJsonIpcServer, type JsonIpcServerHandle } from "@open-design/sidecar";
import { SIDECAR_ENV, SIDECAR_MESSAGES } from "@open-design/sidecar-proto";
import { resolveDaemonUrl, DEFAULT_DAEMON_URL } from "../src/daemon-url.js";

// Verifies the resolution chain: --daemon-url > OD_DAEMON_URL > sidecar
// IPC status discovery > legacy default. Each layer must short-circuit the next
// so `od` clients follow the live daemon across ephemeral-port restarts.

describe("resolveDaemonUrl", () => {
  let ipcBaseDir: string;

  beforeAll(() => {
    ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "od-mcp-resolve-"));
  });

  afterAll(() => {
    fs.rmSync(ipcBaseDir, { recursive: true, force: true });
  });

  it("prefers the explicit --daemon-url flag", async () => {
    const url = await resolveDaemonUrl({
      flagUrl: "http://flag.example:1111",
      env: {
        OD_DAEMON_URL: "http://env.example:2222",
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "daemon.sock"),
      },
    });
    expect(url).toBe("http://flag.example:1111");
  });

  it("falls back to OD_DAEMON_URL when no flag given", async () => {
    const url = await resolveDaemonUrl({
      env: {
        OD_DAEMON_URL: "http://env.example:2222",
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "daemon.sock"),
      },
    });
    expect(url).toBe("http://env.example:2222");
  });

  it("returns the legacy default when no flag/env/socket is available", async () => {
    const url = await resolveDaemonUrl({
      env: {
        [SIDECAR_ENV.IPC_PATH]: path.join(ipcBaseDir, "missing.sock"),
        // Pin the scan base to an empty dir: without this, the namespace scan
        // would find a real dev daemon on contributor machines and flake.
        [SIDECAR_ENV.IPC_BASE]: path.join(ipcBaseDir, "empty-scan-base"),
      },
      timeoutMs: 200,
    });
    expect(url).toBe(DEFAULT_DAEMON_URL);
  });

  it("discovers the live daemon URL via the concrete sidecar IPC status endpoint", async () => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\open-design-daemon-url-${process.pid}-${Date.now()}`
      : path.join(ipcBaseDir, "daemon.sock");
    let ipc: JsonIpcServerHandle | null = null;
    try {
      ipc = await createJsonIpcServer({
        socketPath,
        handler: (message) => {
          if (
            message != null &&
            typeof message === "object" &&
            (message as { type?: unknown }).type === SIDECAR_MESSAGES.STATUS
          ) {
            return {
              pid: 4242,
              state: "running",
              updatedAt: new Date().toISOString(),
              url: "http://127.0.0.1:54321",
            };
          }
          throw new Error("unexpected message");
        },
      });

      const url = await resolveDaemonUrl({
        env: {
          [SIDECAR_ENV.IPC_PATH]: socketPath,
        },
        timeoutMs: 1000,
      });
      expect(url).toBe("http://127.0.0.1:54321");
    } finally {
      await ipc?.close();
    }
  });

  const statusHandler = (url: string) => (message: unknown) => {
    if (
      message != null &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === SIDECAR_MESSAGES.STATUS
    ) {
      return { pid: 4242, state: "running", updatedAt: new Date().toISOString(), url };
    }
    throw new Error("unexpected message");
  };

  // 零配置自发现:客户 shell 里没有任何 OD_* 环境变量,npm 装的 od/multimedia
  // 靠扫描固定 IPC base 找到桌面端(打包版)daemon。POSIX socket 语义,win 走
  // 命名管道枚举(此处跳过)。
  it.skipIf(process.platform === "win32")(
    "discovers a live daemon by scanning the IPC base when no env vars are set",
    async () => {
      const scanBase = fs.mkdtempSync(path.join(os.tmpdir(), "od-scan-base-"));
      fs.mkdirSync(path.join(scanBase, "release-mac"), { recursive: true });
      let ipc: JsonIpcServerHandle | null = null;
      try {
        ipc = await createJsonIpcServer({
          socketPath: path.join(scanBase, "release-mac", "daemon.sock"),
          handler: statusHandler("http://127.0.0.1:61001"),
        });
        const url = await resolveDaemonUrl({
          env: { [SIDECAR_ENV.IPC_BASE]: scanBase },
          timeoutMs: 1000,
        });
        expect(url).toBe("http://127.0.0.1:61001");
      } finally {
        await ipc?.close();
        fs.rmSync(scanBase, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "prefers the default (dev) namespace over other namespaces when both are live",
    async () => {
      const scanBase = fs.mkdtempSync(path.join(os.tmpdir(), "od-scan-order-"));
      fs.mkdirSync(path.join(scanBase, "default"), { recursive: true });
      fs.mkdirSync(path.join(scanBase, "aaa-packaged"), { recursive: true });
      let devIpc: JsonIpcServerHandle | null = null;
      let packagedIpc: JsonIpcServerHandle | null = null;
      try {
        devIpc = await createJsonIpcServer({
          socketPath: path.join(scanBase, "default", "daemon.sock"),
          handler: statusHandler("http://127.0.0.1:61002"),
        });
        packagedIpc = await createJsonIpcServer({
          socketPath: path.join(scanBase, "aaa-packaged", "daemon.sock"),
          handler: statusHandler("http://127.0.0.1:61003"),
        });
        const url = await resolveDaemonUrl({
          env: { [SIDECAR_ENV.IPC_BASE]: scanBase },
          timeoutMs: 1000,
        });
        expect(url).toBe("http://127.0.0.1:61002"); // default 先于字典序更小的其它命名空间
      } finally {
        await devIpc?.close();
        await packagedIpc?.close();
        fs.rmSync(scanBase, { recursive: true, force: true });
      }
    },
  );
});
