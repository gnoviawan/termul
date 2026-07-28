// @ts-expect-error The production helper is intentionally plain ESM for direct workflow use.
import { preparePlatformArtifacts } from "./prepare-platform-artifacts.mjs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

async function fixtureDir() {
	return mkdtemp(join(tmpdir(), "termul-platform-artifacts-"));
}

async function fixtureFile(root: string, relativePath: string, content = "artifact") {
	const path = join(root, ...relativePath.split("/"));
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	return path;
}

async function prepare(platform: string, paths: string[], root: string) {
	const artifactsPath = join(root, `${platform}-paths.json`);
	const outputPath = join(root, `${platform}-output`);
	await writeFile(artifactsPath, JSON.stringify(paths));
	const manifest = await preparePlatformArtifacts({
		platform,
		version: "1.2.3",
		tag: "v1.2.3",
		artifactsPath,
		outputPath,
	});
	return { manifest, outputPath };
}

describe("preparePlatformArtifacts", () => {
	test.each([
		["macos-aarch64", "aarch64", "darwin-aarch64"],
		["macos-x64", "x64", "darwin-x86_64"],
	])("renames %s updater assets and preserves signature association", async (platform, arch, key) => {
		const root = await fixtureDir();
		const archive = await fixtureFile(root, "bundle/macos/Termul Manager.app.tar.gz");
		const signature = await fixtureFile(
			root,
			"bundle/macos/Termul Manager.app.tar.gz.sig",
			`signature-${arch}\n`,
		);
		const dmg = await fixtureFile(root, `bundle/dmg/Termul.Manager_1.2.3_${arch}.dmg`);

		const { manifest, outputPath } = await prepare(platform, [archive, signature, dmg], root);
		const updaterName = `Termul.Manager_${arch}.app.tar.gz`;

		expect(manifest.assetNames).toContain(updaterName);
		expect(manifest.assetNames).toContain(`${updaterName}.sig`);
		expect(manifest.platforms[key]).toEqual({
			url: `https://github.com/gnoviawan/termul/releases/download/v1.2.3/${updaterName}`,
			signature: `signature-${arch}`,
		});
		expect(await readFile(join(outputPath, "assets", `${updaterName}.sig`), "utf8")).toBe(
			`signature-${arch}\n`,
		);
	});

	test("collects Windows MSI and NSIS paths", async () => {
		const root = await fixtureDir();
		const msi = await fixtureFile(root, "bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi");
		const msiSig = await fixtureFile(
			root,
			"bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig",
			"msi-signature",
		);
		const exe = await fixtureFile(root, "bundle/nsis/Termul.Manager_1.2.3_x64-setup.exe");
		const exeSig = await fixtureFile(
			root,
			"bundle/nsis/Termul.Manager_1.2.3_x64-setup.exe.sig",
			"nsis-signature",
		);

		const { manifest } = await prepare("windows-x64", [msi, msiSig, exe, exeSig], root);
		expect(manifest.platforms["windows-x86_64"].url).toMatch(/_x64_en-US\.msi$/);
		expect(manifest.platforms["windows-x86_64-msi"].signature).toBe("msi-signature");
		expect(manifest.platforms["windows-x86_64-nsis"].url).toMatch(/_x64-setup\.exe$/);
	});

	test("collects Linux AppImage, deb, and rpm paths", async () => {
		const root = await fixtureDir();
		const paths = [];
		for (const [bundle, name] of [
			["appimage", "Termul.Manager_1.2.3_amd64.AppImage"],
			["deb", "Termul.Manager_1.2.3_amd64.deb"],
			["rpm", "Termul.Manager-1.2.3-1.x86_64.rpm"],
		]) {
			paths.push(await fixtureFile(root, `bundle/${bundle}/${name}`));
			paths.push(await fixtureFile(root, `bundle/${bundle}/${name}.sig`, `${bundle}-signature`));
		}

		const { manifest } = await prepare("linux-x64", paths, root);
		expect(manifest.platforms["linux-x86_64"].url).toMatch(/\.AppImage$/);
		expect(manifest.platforms["linux-x86_64-appimage"].signature).toBe(
			"appimage-signature",
		);
		expect(manifest.platforms["linux-x86_64-deb"].url).toMatch(/\.deb$/);
		expect(manifest.platforms["linux-x86_64-rpm"].url).toMatch(/\.rpm$/);
	});

	test("rejects duplicate collected asset names even when paths are identical", async () => {
		const root = await fixtureDir();
		const msi = await fixtureFile(root, "bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi");
		const msiSig = await fixtureFile(
			root,
			"bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig",
			"signature",
		);

		await expect(prepare("windows-x64", [msi, msi, msiSig], root)).rejects.toThrow(
			"windows-x64 has duplicate release asset Termul.Manager_1.2.3_x64_en-US.msi",
		);
	});

	test("rejects multiple signatures for one updater bundle", async () => {
		const root = await fixtureDir();
		const first = await fixtureFile(root, "one/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig", "one");
		const second = await fixtureFile(root, "two/msi/Other_1.2.3_x64_en-US.msi.sig", "two");
		const msi = await fixtureFile(root, "one/msi/Termul.Manager_1.2.3_x64_en-US.msi");

		await expect(prepare("windows-x64", [msi, first, second], root)).rejects.toThrow(
			"windows-x64 must have exactly one msi updater signature",
		);
	});
});
