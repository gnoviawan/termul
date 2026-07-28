#!/usr/bin/env node

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const platformDefinitions = {
	"windows-x64": {
		requiredKeys: [
			"windows-x86_64",
			"windows-x86_64-msi",
			"windows-x86_64-nsis",
		],
		primaryBundle: "msi",
	},
	"linux-x64": {
		requiredKeys: [
			"linux-x86_64",
			"linux-x86_64-appimage",
			"linux-x86_64-deb",
			"linux-x86_64-rpm",
		],
		primaryBundle: "appimage",
	},
	"macos-aarch64": {
		requiredKeys: ["darwin-aarch64", "darwin-aarch64-app"],
		primaryBundle: "app",
		arch: "aarch64",
	},
	"macos-x64": {
		requiredKeys: ["darwin-x86_64", "darwin-x86_64-app"],
		primaryBundle: "app",
		arch: "x64",
	},
};

function fail(message) {
	throw new Error(message);
}

function readArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || value === undefined) {
			fail(`Invalid arguments: ${argv.join(" ")}`);
		}
		options[name.slice(2)] = value;
	}
	return options;
}

function normalizeArch(arch) {
	if (["amd64", "x86_64", "x64"].includes(arch)) return "x86_64";
	if (["aarch64", "arm64"].includes(arch)) return "aarch64";
	if (["x86", "i386", "i686"].includes(arch)) return "i686";
	return arch;
}

function detectExtension(name) {
	for (const extension of [
		".app.tar.gz.sig",
		".app.tar.gz",
		".AppImage.tar.gz.sig",
		".AppImage.tar.gz",
		".sig",
	]) {
		if (name.endsWith(extension)) return extension;
	}
	return "";
}

function detectBundle(path) {
	if (path.includes("/msi/") || path.includes("\\msi\\")) return "msi";
	if (path.includes("/nsis/") || path.includes("\\nsis\\")) return "nsis";
	if (path.includes("/appimage/") || path.includes("\\appimage\\")) return "appimage";
	if (path.includes("/deb/") || path.includes("\\deb\\")) return "deb";
	if (path.includes("/rpm/") || path.includes("\\rpm\\")) return "rpm";
	if (path.includes("/macos/") || path.includes("\\macos\\")) return "app";
	return "";
}

function releaseAssetName(artifact) {
	if ([".app.tar.gz", ".app.tar.gz.sig"].includes(artifact.ext)) {
		const appName = basename(artifact.path, artifact.ext).replaceAll(" ", ".");
		return `${appName}_${artifact.arch}${artifact.ext}`;
	}
	return basename(artifact.path);
}

function assertNonEmptyString(value, description) {
	if (typeof value !== "string" || value.trim() === "") {
		fail(`${description} must be a nonempty string`);
	}
}

export async function preparePlatformArtifacts({
	platform,
	version,
	tag,
	artifactsPath,
	outputPath,
}) {
	const definition = platformDefinitions[platform];
	if (!definition) fail(`Unsupported platform: ${platform}`);
	assertNonEmptyString(version, "version");
	assertNonEmptyString(tag, "tag");
	assertNonEmptyString(artifactsPath, "artifacts path");
	assertNonEmptyString(outputPath, "output path");

	const artifactPaths = JSON.parse(await readFile(artifactsPath, "utf8"));
	if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) {
		fail(`${platform} artifact list is empty`);
	}

	const filePaths = [];
	for (const path of artifactPaths) {
		assertNonEmptyString(path, `${platform} artifact path`);
		if ((await stat(path)).isFile()) filePaths.push(path);
	}
	if (filePaths.length === 0) fail(`${platform} artifact list contains no files`);

	const artifacts = filePaths.map((path) => ({
		path,
		ext: detectExtension(basename(path)),
		bundle: detectBundle(path),
		arch: definition.arch ?? "",
		assetName: "",
	}));

	const assetSources = new Map();
	for (const artifact of artifacts) {
		artifact.assetName = releaseAssetName(artifact);
		const existingPath = assetSources.get(artifact.assetName);
		if (existingPath) {
			fail(`${platform} has duplicate release asset ${artifact.assetName}`);
		}
		assetSources.set(artifact.assetName, artifact.path);
	}

	await mkdir(join(outputPath, "assets"), { recursive: true });
	for (const artifact of artifacts) {
		await copyFile(artifact.path, join(outputPath, "assets", artifact.assetName));
	}

	const signatures = artifacts.filter((artifact) => artifact.assetName.endsWith(".sig"));
	const platforms = {};
	const entryForBundle = async (bundle) => {
		const matchingSignatures = signatures.filter((artifact) => artifact.bundle === bundle);
		if (matchingSignatures.length !== 1) {
			fail(`${platform} must have exactly one ${bundle} updater signature`);
		}
		const signatureArtifact = matchingSignatures[0];
		const updaterAssetName = signatureArtifact.assetName.slice(0, -4);
		const matchingAssets = artifacts.filter(
			(artifact) => artifact.assetName === updaterAssetName,
		);
		if (matchingAssets.length !== 1) {
			fail(`${platform} signature has no unique matching updater asset: ${updaterAssetName}`);
		}
		const signature = (await readFile(signatureArtifact.path, "utf8")).trim();
		assertNonEmptyString(signature, `${platform} ${bundle} signature`);
		return {
			url: `https://github.com/gnoviawan/termul/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(updaterAssetName)}`,
			signature,
		};
	};

	if (platform === "windows-x64") {
		platforms["windows-x86_64"] = await entryForBundle(definition.primaryBundle);
		platforms["windows-x86_64-msi"] = await entryForBundle("msi");
		platforms["windows-x86_64-nsis"] = await entryForBundle("nsis");
	} else if (platform === "linux-x64") {
		platforms["linux-x86_64"] = await entryForBundle(definition.primaryBundle);
		platforms["linux-x86_64-appimage"] = await entryForBundle("appimage");
		platforms["linux-x86_64-deb"] = await entryForBundle("deb");
		platforms["linux-x86_64-rpm"] = await entryForBundle("rpm");
	} else {
		const arch = normalizeArch(definition.arch);
		const entry = await entryForBundle("app");
		platforms[`darwin-${arch}`] = entry;
		platforms[`darwin-${arch}-app`] = entry;
	}

	for (const key of definition.requiredKeys) {
		if (!platforms[key]) fail(`${platform} did not produce required updater platform ${key}`);
	}

	const manifest = { platform, version, assetNames: [...assetSources.keys()], platforms };
	await writeFile(
		join(outputPath, "platform-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return manifest;
}

async function runCli() {
	const options = readArguments(process.argv.slice(2));
	await preparePlatformArtifacts({
		platform: options.platform,
		version: options.version,
		tag: options.tag,
		artifactsPath: options.artifacts,
		outputPath: options.output,
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
