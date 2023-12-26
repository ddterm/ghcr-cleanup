#!/usr/bin/env node

import stream from 'node:stream';
import url from 'node:url';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import merge_stream from 'merge-stream';

const Octokit = (await import('@octokit/core')).Octokit.plugin(
    (await import('@octokit/plugin-paginate-rest')).paginateRest,
    (await import('@octokit/plugin-throttling')).throttling,
    (await import('@octokit/plugin-retry')).retry,
    (await import('@octokit/plugin-request-log')).requestLog
)

// from docker/metadata-action
function sanitizeTag(tag) {
    return tag.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

class DockerRepository {
    constructor(registry, repository, namespace) {
        this.registry = registry;
        this.baseUrl = registry.resolveUrl(`/v2/${namespace}/${repository}/`);
    }

    resolveUrl(relative) {
        return new url.URL(relative, this.baseUrl).toString();
    }

    async fetchJson(url, contentTypes) {
        return await this.registry.fetchJson(this.resolveUrl(url), contentTypes);
    }

    async fetchManifests(reference) {
        const manifestTypes = [
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
        ];

        const indexTypes = [
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.index.v1+json',
        ];

        const response = await this.fetchJson(`./manifests/${reference}`, [
            ...manifestTypes,
            ...indexTypes,
        ]);

        response.reference = reference;

        if (manifestTypes.includes(response.mediaType)) {
            return stream.Readable.from([response]);
        }

        if (indexTypes.includes(response.mediaType)) {
            return stream.Readable.from(response.manifests).flatMap(
                manifest => this.fetchManifests(manifest.digest)
            ).map(manifest => {
                return { ...manifest, parent: response };
            });
        }

        throw new Error(`Unknown mediaType: ${response.mediaType}`);
    }

    async fetchConfig(manifest) {
        const data = await this.fetchJson(`./blobs/${manifest.config.digest}`, [
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
        ]);

        data.manifest = manifest;
        return data;
    }

    async fetchConfigs(reference) {
        const manifests = await this.fetchManifests(reference);

        return manifests.map(manifest => this.fetchConfig(manifest));
    }
}

class DockerRegistry {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl;

        this.auth = {
            'Authorization': `bearer ${Buffer.from(token).toString('base64')}`
        };
    }

    resolveUrl(relative) {
        return new url.URL(relative, this.baseUrl).toString();
    }

    async fetch(url, contentTypes) {
        const headers = new Headers(this.auth);

        for (const contentType of contentTypes) {
            headers.append('Accept', contentType);
        }

        const response = await globalThis.fetch(this.resolveUrl(url), { headers });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.url}: ${response.status} ${response.statusText}`);
        }

        return response;
    }

    async fetchJson(url, contentTypes) {
        const response = await this.fetch(url, contentTypes);

        return await response.json();
    }
}

async function main() {
    const logLevels = ['debug', 'info', 'warn', 'error'];

    const args = yargs(hideBin(process.argv))
        .option('token', {
            alias: 't',
            demandOption: true,
            describe: 'GitHub API token',
            type: 'string',
            requiresArg: true,
            default: process.env.GITHUB_TOKEN,
            defaultDescription: '$GITHUB_TOKEN',
        })
        .option('repository', {
            alias: 'r',
            demandOption: true,
            describe: 'GitHub repository name',
            type: 'string',
            requiresArg: true,
            default: process.env.GITHUB_REPOSITORY,
            defaultDescription: '$GITHUB_REPOSITORY',
        })
        .option('owner', {
            alias: 'o',
            demandOption: true,
            describe: 'Package owner',
            type: 'string',
            requiresArg: true,
            default: process.env.GITHUB_REPOSITORY_OWNER,
            defaultDescription: '$GITHUB_REPOSITORY_OWNER',
        })
        .option('api-url', {
            alias: 'u',
            demandOption: true,
            describe: 'GitHub API base URL',
            type: 'string',
            requiresArg: true,
            default: process.env.GITHUB_API_URL || 'https://api.github.com',
            defaultDescription: '$GITHUB_API_URL or https://api.github.com',
        })
        .option('registry-url', {
            alias: 'd',
            demandOption: true,
            describe: 'Container registry URL',
            type: 'string',
            requiresArg: true,
            default: 'https://ghcr.io',
        })
        .option('log-level', {
            alias: 'v',
            demandOption: true,
            describe: 'Console log level',
            choices: logLevels,
            requiresArg: true,
            default: 'info',
        })
        .option('jobs', {
            alias: 'j',
            demandOption: true,
            describe: 'Concurrency level',
            type: 'number',
            requiresArg: true,
            default: 1,
        })
        .option('dry-run', {
            alias: 'n',
            type: 'boolean',
            describe: 'Do not delete packages, only print messages',
        })
        .strict()
        .argv;

    const logLevel = logLevels.indexOf(args.logLevel)
    const log = Object.fromEntries(
        logLevels.map(
            (name, index) => [name, index >= logLevel ? console[name].bind(console) : new Function()]
        )
    );

    const octokit = new Octokit({
        auth: args.token,
        baseUrl: args.apiUrl,
        log,
        throttle: {
            onRateLimit: (retryAfter, options, octokit) => {
                octokit.log.warn(
                    `Request quota exhausted for request ${options.method} ${options.url}`
                );

                if (options.request.retryCount === 0) {
                    // only retries once
                    octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onSecondaryRateLimit: (retryAfter, options, octokit) => {
                // does not retry, only logs a warning
                octokit.log.warn(
                    `SecondaryRateLimit detected for request ${options.method} ${options.url}`
                );
            },
        },
    });

    octokit.hook.after('request', async (response, options) => {
        octokit.log.debug(response);
    });

    const concurrencyOptions = {
        concurrency: args.jobs,
    }

    const ownerPrefix = `${args.owner}/`;

    const repo = (await octokit.request(
        'GET /repos/{owner}/{repo}',
        {
            owner: args.owner,
            repo: args.repository.startsWith(ownerPrefix) ? args.repository.substring(ownerPrefix.length) : args.repository,
        }
    )).data;

    const branches = stream.Readable.from(
        octokit.paginate.iterator(repo.branches_url, { per_page: 100 })
    ).flatMap(response => response.data).map(branch => branch.name);

    const prs = stream.Readable.from(
        octokit.paginate.iterator(repo.pulls_url, { state: 'open', per_page: 100 })
    ).flatMap(response => response.data).map(pr => `pr-${pr.number}`);

    const tags = stream.Readable.from(
        octokit.paginate.iterator(repo.tags_url, { per_page: 100 } )
    ).flatMap(response => response.data).map(tag => tag.name);

    const refs = await merge_stream(branches, tags, prs).map(sanitizeTag).toArray();

    octokit.log.info(`Branches and tags found: ${JSON.stringify(refs)}`);

    const packages = stream.Readable.from(
        octokit.paginate.iterator(
            'GET {+user_url}/packages',
            {
                user_url: repo.owner.url,
                package_type: 'container',
                per_page: 100,
            }
        )
    ).flatMap(response => response.data);

    const repoPackages = packages.filter(
        pkg => (
            pkg.repository && pkg.repository.node_id === repo.node_id
        )
    );

    const repoPackagesWithVersions = repoPackages.map(
        async pkg => {
            pkg.versions = await stream.Readable.from(
                octokit.paginate.iterator(
                    'GET {+package_url}/versions',
                    {
                        package_url: pkg.url,
                        per_page: 100,
                    }
                )
            ).flatMap(response => response.data).toArray();

            return pkg;
        },
        concurrencyOptions,
    );

    const registry = new DockerRegistry(args.registryUrl, args.token, log);

    const versions = repoPackagesWithVersions.flatMap(
        pkg => {
            const repository = new DockerRepository(registry, pkg.name, pkg.owner.login);
            const image = `${pkg.owner.login}/${pkg.name}`;

            return pkg.versions.map(version => {
                version.repository = repository;
                version.image = `${image}@${version.name}`;

                const tags = version.metadata.container.tags;
                version.displayImage = tags.length > 0 ? `${image}:${tags[0]}` : version.image;

                return version;
            });
        }
    );

    const minAge = new Date();
    minAge.setDate(minAge.getDate() - 1);

    const maxAge = new Date();
    maxAge.setFullYear(minAge.getFullYear() - 1);

    const toDelete = versions.filter(
        async version => {
            octokit.log.debug(`Processing ${version.displayImage}`);

            try {
                const updated = new Date(version.updated_at);

                if (updated > minAge) {
                    octokit.log.info(`Image ${version.displayImage} is too new`, updated);
                    return false;
                }

                if (updated < maxAge) {
                    octokit.log.info(`Image ${version.displayImage} is too old`, updated);
                    return true;
                }

                const configs = await version.repository.fetchConfigs(version.name);

                return await configs.every(async config => {
                    const refName = config.config.Labels['org.opencontainers.image.version'];

                    if (!refName) {
                        octokit.log.error(`Image ${version.displayImage} has no version label`, version);
                        return false;
                    }

                    octokit.log.debug(`Version of ${version.displayImage}: ${refName}`);
                    return !refs.includes(refName);
                });
            } catch (ex) {
                octokit.log.error(`Error while processing ${version.displayImage}: ${ex}`, version);
            }
        },
        concurrencyOptions,
    );

    const deleted = await toDelete.map(version => {
        octokit.log.info(`Deleting ${version.displayImage} - ${version.html_url}`);

        if (args.dryRun) {
            octokit.log.info(`DELETE ${version.url}`);
        } else {
            return octokit.request('DELETE {+version_url}', { version_url: version.url });
        }
    }, concurrencyOptions).reduce(previous => previous + 1, 0);

    if (args.dryRun) {
        octokit.log.info(`Will delete ${deleted} package versions`);
    } else {
        octokit.log.info(`Deleted ${deleted} package versions`);
    }
}

main();
