#!/usr/bin/env node

const http = require('http');
const https = require('https');
const stream = require('node:stream');
const url = require('node:url');

const yargs = require('yargs/yargs');
const merge_stream = require('merge-stream');

const Octokit = require('@octokit/core').Octokit.plugin(
    require('@octokit/plugin-paginate-rest').paginateRest,
    require('@octokit/plugin-throttling').throttling,
    require('@octokit/plugin-retry').retry,
    require('@octokit/plugin-request-log').requestLog,
)

// from docker/metadata-action
function sanitizeTag(tag) {
    return tag.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function main() {
    const args = yargs(require('yargs/helpers').hideBin(process.argv))
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
            choices: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
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

    const octokit = new Octokit({
        auth: args.token,
        baseUrl: args.apiUrl,
        log: require('console-log-level')({
            level: args.logLevel,
        }),
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
        octokit.paginate.iterator(repo.branches_url, {})
    ).flatMap(response => response.data).map(branch => branch.name);

    const tags = stream.Readable.from(
        octokit.paginate.iterator(repo.tags_url)
    ).flatMap(response => response.data).map(tag => tag.name);

    const refs = await merge_stream(branches, tags).map(sanitizeTag).toArray();

    octokit.log.info(`Branches and tags found: ${JSON.stringify(refs)}`);

    const packages = stream.Readable.from(
        octokit.paginate.iterator(
            'GET {+user_url}/packages',
            {
                user_url: repo.owner.url,
                package_type: 'container',
            }
        )
    ).flatMap(response => response.data);

    const repoPackages = packages.filter(
        package => (
            package.repository && package.repository.node_id === repo.node_id
        )
    );

    const repoPackagesWithVersions = repoPackages.map(
        async package => {
            package.versions = await stream.Readable.from(
                octokit.paginate.iterator(
                    'GET {+package_url}/versions',
                    { package_url: package.url }
                )
            ).flatMap(response => response.data).toArray();

            return package;
        },
        concurrencyOptions,
    );

    const registryUrl = new url.URL(args.registryUrl);

    const versions = repoPackagesWithVersions.flatMap(
        package => {
            const image = `${registryUrl.host}/${package.owner.login}/${package.name}`;
            const registryBaseUrl = new url.URL(`/v2/${package.owner.login}/${package.name}/`, registryUrl).toString();

            return package.versions.map(version => {
                version.image = `${image}@${version.name}`;
                version.manifestUrl = new url.URL(`./manifests/${version.name}`, registryBaseUrl).toString();
                version.blobBaseUrl = new url.URL('./blobs/', registryBaseUrl).toString();

                const tags = version.metadata.container.tags;
                version.displayImage = tags.length > 0 ? `${image}:${tags[0]}` : version.image;

                return version;
            });
        }
    );

    const dockerRegistryAuth = {
        'Authorization': `bearer ${Buffer.from(args.token).toString('base64')}`
    };

    const dockerRegistryFetch = async (url, contentTypes) => {
        const headers = new Headers(dockerRegistryAuth);

        for (const contentType of contentTypes) {
            headers.append('Accept', contentType);
        }

        const response = await fetch(url, { headers });
        return await response.json();
    };

    const dockerManifestTypes = [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json'
    ];

    const dockerConfigTypes = [
        'application/vnd.docker.container.image.v1+json',
        'application/vnd.oci.image.config.v1+json'
    ];

    const fetchDockerImageConfig = async version => {
        octokit.log.debug(`Getting image config for ${version.image}`, version.manifestUrl);

        const manifest = await dockerRegistryFetch(version.manifestUrl, dockerManifestTypes);
        const digest = manifest?.config?.digest;
        if (!digest) {
            octokit.log.warn(`Can't get digest for ${version.image} config from manifest`, manifest);
            return null;
        }

        version.configUrl = new url.URL(`./${digest}`, version.blobBaseUrl).toString();
        return await dockerRegistryFetch(version.configUrl, dockerConfigTypes);
    }

    const minAge = new Date();
    minAge.setDate(minAge.getDate() - 1);

    const toDelete = versions.filter(
        async version => {
            octokit.log.debug(`Processing ${version.displayImage}`);

            const config = await fetchDockerImageConfig(version);

            const created = Date.parse(config?.created);
            if (isNaN(created)) {
                octokit.log.warn(`No created date in ${version.image} config`, config);
                return false;
            }

            if (created > minAge) {
                octokit.log.info(`Image ${version.image} is too new`, created);
                return false;
            }

            const labels = config?.config?.Labels;
            const refName = labels ? labels['org.opencontainers.image.version'] : null;
            octokit.log.debug(`Version of ${version.image}: ${refName}`);

            return refName && !refs.includes(refName);
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
