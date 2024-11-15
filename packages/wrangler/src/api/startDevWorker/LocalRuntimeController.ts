import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spinner, spinnerWhile } from "@cloudflare/cli/interactive";
import chalk from "chalk";
import { Json, Miniflare, Mutex } from "miniflare";
import mixedModeServer from "worker:MixedModeWorker.ts";
import { fetchResult } from "../../cfetch";
import { createWorkerUploadForm } from "../../deployment-bundle/create-worker-upload-form";
import { CfWorkerInit } from "../../deployment-bundle/worker";
import * as MF from "../../dev/miniflare";
import { logger } from "../../logger";
import { RuntimeController } from "./BaseController";
import { castErrorCause } from "./events";
import { convertBindingsToCfWorkerInitBindings, unwrapHook } from "./utils";
import type { WorkerEntrypointsDefinition } from "../../dev-registry";
import type {
	BundleCompleteEvent,
	BundleStartEvent,
	PreviewTokenExpiredEvent,
	ReloadCompleteEvent,
	ReloadStartEvent,
} from "./events";
import type { Binding, File, StartDevWorkerOptions } from "./types";

async function getBinaryFileContents(file: File<string | Uint8Array>) {
	if ("contents" in file) {
		if (file.contents instanceof Buffer) {
			return file.contents;
		}
		return Buffer.from(file.contents);
	}
	return readFile(file.path);
}
async function getTextFileContents(file: File<string | Uint8Array>) {
	if ("contents" in file) {
		if (typeof file.contents === "string") {
			return file.contents;
		}
		if (file.contents instanceof Buffer) {
			return file.contents.toString();
		}
		return Buffer.from(file.contents).toString();
	}
	return readFile(file.path, "utf8");
}

const DEFAULT_WORKER_NAME = "worker";
function getName(config: StartDevWorkerOptions) {
	return config.name ?? DEFAULT_WORKER_NAME;
}

async function convertToConfigBundle(
	event: BundleCompleteEvent
): Promise<MF.ConfigBundle> {
	const { bindings, fetchers } = await convertBindingsToCfWorkerInitBindings(
		event.config.bindings
	);

	const crons = [];
	const queueConsumers = [];
	for (const trigger of event.config.triggers ?? []) {
		if (trigger.type === "cron") {
			crons.push(trigger.cron);
		} else if (trigger.type === "queue-consumer") {
			queueConsumers.push(trigger);
		}
	}
	if (event.bundle.entry.format === "service-worker") {
		// For the service-worker format, blobs are accessible on the global scope
		for (const module of event.bundle.modules ?? []) {
			const identifier = MF.getIdentifier(module.name);
			if (module.type === "text") {
				bindings.vars ??= {};
				bindings.vars[identifier] = await getTextFileContents({
					contents: module.content,
				});
			} else if (module.type === "buffer") {
				bindings.data_blobs ??= {};
				bindings.data_blobs[identifier] = await getBinaryFileContents({
					contents: module.content,
				});
			} else if (module.type === "compiled-wasm") {
				bindings.wasm_modules ??= {};
				bindings.wasm_modules[identifier] = await getBinaryFileContents({
					contents: module.content,
				});
			}
		}
		event.bundle = { ...event.bundle, modules: [] };
	}

	return {
		name: event.config.name,
		bundle: event.bundle,
		format: event.bundle.entry.format,
		compatibilityDate: event.config.compatibilityDate,
		compatibilityFlags: event.config.compatibilityFlags,
		bindings,
		migrations: event.config.migrations,
		workerDefinitions: event.config.dev?.registry,
		legacyAssetPaths: event.config.legacy?.site?.bucket
			? {
					baseDirectory: event.config.legacy?.site?.bucket,
					assetDirectory: "",
					excludePatterns: event.config.legacy?.site?.exclude ?? [],
					includePatterns: event.config.legacy?.site?.include ?? [],
				}
			: undefined,
		assets: event.config?.assets,
		initialPort: undefined,
		initialIp: "127.0.0.1",
		rules: [],
		inspectorPort: 0,
		localPersistencePath: event.config.dev.persist,
		liveReload: event.config.dev?.liveReload ?? false,
		crons,
		queueConsumers,
		localProtocol: event.config.dev?.server?.secure ? "https" : "http",
		httpsCertPath: event.config.dev?.server?.httpsCertPath,
		httpsKeyPath: event.config.dev?.server?.httpsKeyPath,
		localUpstream: event.config.dev?.origin?.hostname,
		upstreamProtocol: event.config.dev?.origin?.secure ? "https" : "http",
		inspect: true,
		services: bindings.services,
		serviceBindings: fetchers,
		bindVectorizeToProd: event.config.dev?.bindVectorizeToProd ?? false,
		testScheduled: !!event.config.dev.testScheduled,
	};
}

export class LocalRuntimeController extends RuntimeController {
	// ******************
	//   Event Handlers
	// ******************

	#log = MF.buildLog();
	#currentBundleId = 0;

	// This is given as a shared secret to the Proxy and User workers
	// so that the User Worker can trust aspects of HTTP requests from the Proxy Worker
	// if it provides the secret in a `MF-Proxy-Shared-Secret` header.
	#proxyToUserWorkerAuthenticationSecret = randomUUID();

	// `buildMiniflareOptions()` is asynchronous, meaning if multiple bundle
	// updates were submitted, the second may apply before the first. Therefore,
	// wrap updates in a mutex, so they're always applied in invocation order.
	#mutex = new Mutex();
	#mf?: Miniflare;

	onBundleStart(_: BundleStartEvent) {
		// Ignored in local runtime
	}

	#previousRemoteBindings?: {
		hash: string;
		url?: string;
		headers?: Record<string, string>;
	};

	async ensureMixedModeProxyRunning(config: StartDevWorkerOptions) {
		const remoteBindings = Object.fromEntries(
			Object.entries(config.bindings ?? []).filter(([_name, val]) =>
				"remote" in val ? val.remote : false
			)
		);

		if (
			Object.keys(remoteBindings).length === 0 ||
			this.#previousRemoteBindings?.hash === JSON.stringify(remoteBindings)
		) {
			return {
				url: this.#previousRemoteBindings?.url,
				headers: this.#previousRemoteBindings?.headers,
			};
		}
		logger.log("Setting up remote data access");

		this.#previousRemoteBindings = { hash: JSON.stringify(remoteBindings) };

		const auth = await unwrapHook(config.dev.auth);

		assert(auth, "Auth is required for mixed mode");

		const workerUrl = `/accounts/${auth.accountId}/workers/scripts/wrangler-mixed-mode-proxy`;

		const worker: CfWorkerInit = {
			name: "wrangler-mixed-mode-proxy",
			main: {
				name: "index.js",
				content: await readFile(mixedModeServer, "utf-8"),
				filePath: mixedModeServer,
				type: "esm",
			},
			bindings: (
				await convertBindingsToCfWorkerInitBindings({
					...remoteBindings,
					SINGLETON: {
						type: "durable_object_namespace",
						class_name: "ProxySingleton",
					},
				})
			).bindings,
			modules: [],
			compatibility_date: "2024-01-01",
			compatibility_flags: ["nodejs_compat"],
			keepVars: false,
			sourceMaps: undefined,
			keepSecrets: false,
			logpush: undefined,
			placement: undefined,
			tail_consumers: undefined,
			limits: undefined,
			assets: undefined,
			observability: undefined,
		};

		const body = createWorkerUploadForm(worker);

		const result = await fetchResult<{
			id: string;
			startup_time_ms: number;
			metadata: {
				has_preview: boolean;
			};
		}>(workerUrl, {
			method: "PUT",
			body,
		});
		this.#previousRemoteBindings.url =
			"https://wrangler-mixed-mode-proxy.s.workers.dev";
		this.#previousRemoteBindings.headers = {
			"X-Token": "ajofuviueqrgo8iquehisadcvsdivcbiu",
		};

		return {
			url: this.#previousRemoteBindings.url,
			headers: this.#previousRemoteBindings.headers,
		};
	}

	async #onBundleComplete(data: BundleCompleteEvent, id: number) {
		try {
			const { url, headers } = await this.ensureMixedModeProxyRunning(
				data.config
			);

			const { options, internalObjects, entrypointNames } =
				await MF.buildMiniflareOptions(
					this.#log,
					await convertToConfigBundle({
						...data,
						config: {
							...data.config,
							bindings: {
								...data.config.bindings,
								MIXED_MODE_SETTINGS: {
									type: "json",
									value: url ? { url, headers } : null,
								},
							},
						},
					}),
					this.#proxyToUserWorkerAuthenticationSecret
				);
			options.liveReload = false; // TODO: set in buildMiniflareOptions once old code path is removed

			if (this.#mf === undefined) {
				logger.log(chalk.dim("⎔ Starting local server..."));
				this.#mf = new Miniflare(options);
			} else {
				logger.log(chalk.dim("⎔ Reloading local server..."));

				await this.#mf.setOptions(options);
			}
			// All asynchronous `Miniflare` methods will wait for all `setOptions()`
			// calls to complete before resolving. To ensure we get the `url` and
			// `inspectorUrl` for this set of `options`, we protect `#mf` with a mutex,
			// so only one update can happen at a time.
			const userWorkerUrl = await this.#mf.ready;
			const userWorkerInspectorUrl = await this.#mf.getInspectorURL();
			// If we received a new `bundleComplete` event before we were able to
			// dispatch a `reloadComplete` for this bundle, ignore this bundle.
			if (id !== this.#currentBundleId) {
				return;
			}

			// Get entrypoint addresses
			const entrypointAddresses: WorkerEntrypointsDefinition = {};
			for (const name of entrypointNames) {
				const directUrl = await this.#mf.unsafeGetDirectURL(undefined, name);
				const port = parseInt(directUrl.port);
				entrypointAddresses[name] = { host: directUrl.hostname, port };
			}
			this.emitReloadCompleteEvent({
				type: "reloadComplete",
				config: data.config,
				bundle: data.bundle,
				proxyData: {
					userWorkerUrl: {
						protocol: userWorkerUrl.protocol,
						hostname: userWorkerUrl.hostname,
						port: userWorkerUrl.port,
					},
					userWorkerInspectorUrl: {
						protocol: userWorkerInspectorUrl.protocol,
						hostname: userWorkerInspectorUrl.hostname,
						port: userWorkerInspectorUrl.port,
						pathname: `/core:user:${getName(data.config)}`,
					},
					userWorkerInnerUrlOverrides: {
						protocol: data.config?.dev?.origin?.secure ? "https:" : "http:",
						hostname: data.config?.dev?.origin?.hostname,
						port: data.config?.dev?.origin?.hostname ? "" : undefined,
					},
					headers: {
						// Passing this signature from Proxy Worker allows the User Worker to trust the request.
						"MF-Proxy-Shared-Secret":
							this.#proxyToUserWorkerAuthenticationSecret,
					},
					liveReload: data.config.dev?.liveReload,
					proxyLogsToController: data.bundle.entry.format === "service-worker",
					internalDurableObjects: internalObjects,
					entrypointAddresses,
				},
			});
		} catch (error) {
			this.emitErrorEvent({
				type: "error",
				reason: "Error reloading local server",
				cause: castErrorCause(error),
				source: "LocalRuntimeController",
				data: undefined,
			});
		}
	}
	onBundleComplete(data: BundleCompleteEvent) {
		const id = ++this.#currentBundleId;

		if (data.config.dev?.remote) {
			void this.teardown();
			return;
		}

		this.emitReloadStartEvent({
			type: "reloadStart",
			config: data.config,
			bundle: data.bundle,
		});
		void this.#mutex.runWith(() => this.#onBundleComplete(data, id));
	}
	onPreviewTokenExpired(_: PreviewTokenExpiredEvent): void {
		// Ignored in local runtime
	}

	#teardown = async (): Promise<void> => {
		logger.debug("LocalRuntimeController teardown beginning...");

		if (this.#mf) {
			logger.log(chalk.dim("⎔ Shutting down local server..."));
		}

		await this.#mf?.dispose();
		this.#mf = undefined;

		logger.debug("LocalRuntimeController teardown complete");
	};
	async teardown() {
		return this.#mutex.runWith(this.#teardown);
	}

	// *********************
	//   Event Dispatchers
	// *********************

	emitReloadStartEvent(data: ReloadStartEvent) {
		this.emit("reloadStart", data);
	}
	emitReloadCompleteEvent(data: ReloadCompleteEvent) {
		this.emit("reloadComplete", data);
	}
}
