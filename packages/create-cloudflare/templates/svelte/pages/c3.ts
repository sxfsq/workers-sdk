import { existsSync } from "node:fs";
import { logRaw, updateStatus } from "@cloudflare/cli";
import { blue, brandColor, dim } from "@cloudflare/cli/colors";
import { runFrameworkGenerator } from "frameworks/index";
import { transformFile } from "helpers/codemod";
import { usesTypescript } from "helpers/files";
import { detectPackageManager } from "helpers/packageManagers";
import { installPackages } from "helpers/packages";
import * as recast from "recast";
import type { TemplateConfig } from "../../../src/templates";
import type { C3Context, PackageJson } from "types";

const { npm } = detectPackageManager();

const generate = async (ctx: C3Context) => {
	await runFrameworkGenerator(ctx, ["create", ctx.project.name]);

	logRaw("");
};

const configure = async (ctx: C3Context) => {
	// Install the adapter
	const pkg = `@sveltejs/adapter-cloudflare`;
	await installPackages([pkg], {
		dev: true,
		startText: "Adding the Cloudflare Pages adapter",
		doneText: `${brandColor(`installed`)} ${dim(pkg)}`,
	});

	updateSvelteConfig();
	updatePlaywrightConfig(usesTypescript(ctx));
	updateTypeDefinitions(ctx);
};

const updateSvelteConfig = () => {
	// All we need to do is change the import statement in svelte.config.js
	updateStatus(`Changing adapter in ${blue("svelte.config.js")}`);

	transformFile("svelte.config.js", {
		visitImportDeclaration: function (n) {
			// importSource is the `x` in `import y from "x"`
			const importSource = n.value.source;
			if (importSource.value === "@sveltejs/adapter-auto") {
				importSource.value = "@sveltejs/adapter-cloudflare";
			}

			// stop traversing this node
			return false;
		},
	});
};

const updatePlaywrightConfig = (shouldUseTypescript: boolean) => {
	const filePath = `playwright.config.${shouldUseTypescript ? "ts" : "js"}`;
	if (!existsSync(filePath)) {
		return;
	}

	updateStatus(`Changing webServer port in ${blue(filePath)}`);

	transformFile(filePath, {
		visitObjectExpression: function (n) {
			const portProp = n.node.properties.find((prop) => {
				if (!("key" in prop) || !("name" in prop.key)) {
					return false;
				}

				return prop.key.name === "port";
			});

			if (!portProp || !("value" in portProp) || !("value" in portProp.value)) {
				return this.traverse(n);
			}

			portProp.value.value = 8788;
			return false;
		},
	});
};

const updateTypeDefinitions = (ctx: C3Context) => {
	if (!usesTypescript(ctx)) {
		return;
	}

	updateStatus(`Updating global type definitions in ${blue("app.d.ts")}`);

	const b = recast.types.builders;

	transformFile("src/app.d.ts", {
		visitTSModuleDeclaration(n) {
			if (n.value.id.name === "App" && n.node.body) {
				const moduleBlock = n.node
					.body as recast.types.namedTypes.TSModuleBlock;

				const platformInterface = b.tsInterfaceDeclaration(
					b.identifier("Platform"),
					b.tsInterfaceBody([
						b.tsPropertySignature(
							b.identifier("env"),
							b.tsTypeAnnotation(b.tsTypeReference(b.identifier("Env"))),
						),
						b.tsPropertySignature(
							b.identifier("cf"),
							b.tsTypeAnnotation(
								b.tsTypeReference(b.identifier("CfProperties")),
							),
						),
						b.tsPropertySignature(
							b.identifier("ctx"),
							b.tsTypeAnnotation(
								b.tsTypeReference(b.identifier("ExecutionContext")),
							),
						),
					]),
				);

				moduleBlock.body.unshift(platformInterface);
			}

			this.traverse(n);
		},
	});
};

const typesPath = "src/worker-configuration.d.ts";
const config: TemplateConfig = {
	configVersion: 1,
	id: "svelte",
	frameworkCli: "sv",
	displayName: "SvelteKit",
	platform: "pages",
	hidden: true,
	copyFiles: {
		path: "./templates",
	},
	path: "templates/svelte/pages",
	generate,
	configure,
	transformPackageJson: async (original: PackageJson, ctx: C3Context) => {
		let scripts: Record<string, string> = {
			preview: `${npm} run build && wrangler pages dev`,
			deploy: `${npm} run build && wrangler pages deploy`,
		};

		if (usesTypescript(ctx)) {
			scripts = {
				...scripts,
				"cf-typegen": `wrangler types ${typesPath}`,
			};
		}

		return { scripts };
	},
	devScript: "dev",
	deployScript: "deploy",
	previewScript: "preview",
	typesPath,
};
export default config;
