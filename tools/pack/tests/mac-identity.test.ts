import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { resolveMacInstallIdentity } from "../src/mac/identity.js";
import { resolveMacPaths } from "../src/mac/paths.js";

function makeConfig(root: string, namespace: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "mac",
    portable: true,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", namespace),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dmg",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("resolveMacInstallIdentity", () => {
  it("keeps stable builds on the canonical mac identity", () => {
    expect(resolveMacInstallIdentity(makeConfig("/work", "release-stable"))).toMatchObject({
      appId: "com.social-auto.desktop",
      installerTitle: "social-auto",
      productName: "social-auto",
      publicAppBundleName: "social-auto.app",
      systemAppBundleName: "social-auto.app",
    });
  });

  it("uses first-class beta app identity for beta release namespaces", () => {
    const config = makeConfig("/work", "release-beta");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "com.social-auto.desktop.beta",
      executableName: "social-auto Beta",
      installerTitle: "social-auto Beta",
      productName: "social-auto Beta",
      publicAppBundleName: "social-auto Beta.app",
      systemAppBundleName: "social-auto Beta.app",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/social-auto Beta\.app$/);
  });

  it("uses first-class preview app identity for preview release namespaces", () => {
    const config = makeConfig("/work", "release-preview");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "com.social-auto.desktop.preview",
      executableName: "social-auto Preview",
      installerTitle: "social-auto Preview",
      productName: "social-auto Preview",
      publicAppBundleName: "social-auto Preview.app",
      systemAppBundleName: "social-auto Preview.app",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/social-auto Preview\.app$/);
  });

  it("uses first-class nightly app identity for nightly release versions and namespaces", () => {
    const nightlyVersionConfig = {
      ...makeConfig("/work", "release-stable"),
      appVersion: "0.8.0.nightly.2",
    };
    const nightlyNamespaceConfig = makeConfig("/work", "release-nightly");

    expect(resolveMacInstallIdentity(nightlyVersionConfig)).toEqual({
      appId: "com.social-auto.desktop.nightly",
      executableName: "social-auto Nightly",
      installerTitle: "social-auto Nightly",
      productName: "social-auto Nightly",
      publicAppBundleName: "social-auto Nightly.app",
      systemAppBundleName: "social-auto Nightly.app",
    });
    expect(resolveMacPaths(nightlyVersionConfig).appPath).toMatch(/social-auto Nightly\.app$/);
    expect(resolveMacInstallIdentity(nightlyNamespaceConfig)).toMatchObject({
      productName: "social-auto Nightly",
      publicAppBundleName: "social-auto Nightly.app",
    });
  });
});
