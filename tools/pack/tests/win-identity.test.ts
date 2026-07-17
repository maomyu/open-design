import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveWinInstallIdentity } from "../src/win/identity.js";

describe("resolveWinInstallIdentity", () => {
  it("keeps the default namespace on the canonical Windows display name", () => {
    expect(resolveWinInstallIdentity({ namespace: "default" })).toMatchObject({
      displayName: "Multimedia",
      shortcutName: "Multimedia.lnk",
      uninstallerName: "Uninstall Multimedia.exe",
    });
  });

  it("uses the canonical Windows display name for stable release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-stable-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Multimedia.exe",
      displayName: "Multimedia",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Multimedia-release-stable-win",
      shortcutName: "Multimedia.lnk",
      uninstallerName: "Uninstall Multimedia.exe",
    });
  });

  it("uses first-class beta display identity for beta release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-beta-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Multimedia Beta.exe",
      displayName: "Multimedia Beta",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Multimedia-release-beta-win",
      shortcutName: "Multimedia Beta.lnk",
      uninstallerName: "Uninstall Multimedia Beta.exe",
    });
  });

  it("keeps non-release beta-like namespaces isolated from the real beta channel identity", () => {
    expect(resolveWinInstallIdentity({ namespace: "beta-local-flow" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Multimedia beta-local-flow.exe",
      displayName: "Multimedia beta-local-flow",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Multimedia-beta-local-flow",
      shortcutName: "Multimedia beta-local-flow.lnk",
      uninstallerName: "Uninstall Multimedia beta-local-flow.exe",
    });
  });

  it("uses first-class preview display identity for preview release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-preview-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Multimedia Preview.exe",
      displayName: "Multimedia Preview",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Multimedia-release-preview-win",
      shortcutName: "Multimedia Preview.lnk",
      uninstallerName: "Uninstall Multimedia Preview.exe",
    });
  });

  it("uses first-class nightly display identity for nightly release versions and namespaces", () => {
    expect(resolveWinInstallIdentity({
      appVersion: "0.8.0.nightly.2",
      namespace: "release-stable-win",
    })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Multimedia Nightly.exe",
      displayName: "Multimedia Nightly",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Multimedia-release-stable-win",
      shortcutName: "Multimedia Nightly.lnk",
      uninstallerName: "Uninstall Multimedia Nightly.exe",
    });
    expect(resolveWinInstallIdentity({ namespace: "release-nightly-win" })).toMatchObject({
      displayName: "Multimedia Nightly",
      shortcutName: "Multimedia Nightly.lnk",
    });
  });

  it("keeps the registry DisplayName free of the package version", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    expect(source).toContain('WriteRegStr HKCU "${registryKey}" "DisplayName" "${productName}"');
    expect(source).not.toContain('"DisplayName" "${productName} \\${APP_VERSION}"');
  });

  it("checks the silent install target directory for running instances before overwriting files", async () => {
    const source = await readFile(new URL("../src/win/custom-installer.ts", import.meta.url), "utf8");
    const silentCheck = source.slice(source.indexOf("silent_check:"), source.indexOf("IfFileExists \"$INSTDIR\\\\${exeName}\" existing_install"));
    expect(silentCheck).toContain('IfFileExists "$INSTDIR\\\\${exeName}" 0 silent_detect_running_instances');
    expect(silentCheck).toContain('StrCpy $RunningInstancesInstallRoot "$INSTDIR"');
    expect(silentCheck.indexOf('StrCpy $RunningInstancesInstallRoot "$INSTDIR"')).toBeLessThan(
      silentCheck.indexOf("Call DetectRunningInstances"),
    );
  });
});
