import { findInDir, log, logError, logInfo, logSuccess, logWarning, normalizePath, sleep, trimPath, unixTsToDate, bytesToSizeStr } from "../utils/helpers.ts";
import ignore from "../utils/ignore.ts";
import { SSHGetPutDirectoryOptions, SSHPutFilesOptions } from "node-ssh";
import { runLocalShell, ShellProps, ShellPropsExtended } from "../utils/cli_utils.ts";
import { TFileToUpload, TFileFromServer, TFtpConfig, TStats, OS } from "../types.ts";
import { Config as TSshConfig } from 'node-ssh';
import AdmZip from "adm-zip";
import fs from "node:fs";
import fsPath from "node:path";
import { SFTPWrapper, TransferOptions as SshTransferOptions } from "ssh2";
import { TLSConnectionOptions, useFTP } from "./useFTP.ts";
import { sshConnect, TSshConnect } from "./useSSH.ts";

export const consts = {
    zipFileName: 'barke_deploy_archive.zip',
}

export type TUserConfig = {
    sourceBasePath: string;
    targetOS: OS;
    targetBasePath: string,
    /**
     * This is only for windows servers and is used in SSH mode.
     * If not provided, the default value is '7z x -aoa'.
     */
    windowsServerUnzipCommand?: string;
}

export type TIgnoreConfig = {
    ignorePatterns: string[],
    ignoreFn: (path: string, stat: TStats) => boolean
}
export type TFindNewFilesConfig = TIgnoreConfig & {
    dirsWithManyFiles?: string[]
}

export type TFlags = {
    isDryRun: boolean;
    isFresh: boolean;
    isLogFiles: boolean;
}

export function useExecuter(userConfig: TUserConfig) {
    const startTime = performance.now();
    const flags: TFlags = {
        isDryRun: process.argv.includes('--dry-run'),
        isFresh: process.argv.includes('--fresh'),
        isLogFiles: process.argv.includes('--log-files'),
    }

    return {
        flags,
        sshConnect: (sshConfig: TSshConfig) => sshConnect(userConfig, flags, sshConfig),
        ftpConnect: (ftpInfo: TFtpConfig, secureOptions?: TLSConnectionOptions) => useFTP(userConfig, flags, ftpInfo, secureOptions),
        /**
         * This is only for windows servers.
         */
        useIISHelpers: (sshConn: TSshConnect) => {
            const cd = 'cd C:/Windows/System32/inetsrv ';
            const poolCmd = (method: string, pool: string) => `appcmd ${method} apppool /apppool.name:"${pool}"`;
            const siteCmd = (method: string, site: string) => `appcmd ${method} site /site.name:"${site}"`;
            return {
                restartSite: async (pool: string, site: string) => {
                    logInfo(`\n-> SSH: restarting app pool (${pool}) and site (${site})`);
                    await sshConn.exec({
                        // command: `${cd} && appcmd recycle apppool /apppool.name:"${pool}" && appcmd stop site /site.name:"${site}" && appcmd start site /site.name:"${site}"`,
                        command: [cd, poolCmd('recycle', pool), siteCmd('stop', site), siteCmd('start', site)]
                    }, false);
                },
                stopSite: async (pool: string, site: string) => {
                    logInfo(`\n-> SSH: stopping site (${site})`);
                    await sshConn.exec({
                        command: [cd, poolCmd('stop', pool), siteCmd('stop', site)]
                    }, false);
                },
                startSite: async (pool: string, site: string) => {
                    logInfo(`\n-> SSH: starting site (${site})`);
                    await sshConn.exec({
                        command: [cd, poolCmd('start', pool), siteCmd('start', site)]
                    }, false);
                }
            }
        },
        useLaravelHelpers: () => ({
            local: {
                clearCache: async (clearDebugbar = true) => {
                    logInfo(`\n-> LOCAL: Clearing cache, config, routes, views, events and compiled...`);
                    await runLocalShell({
                        command: 'php artisan optimize:clear',
                        ignore_stdout: true,
                        on_error: 'ignore'
                    });

                    if (clearDebugbar) {
                        logInfo(`\n-> LOCAL: Clearing debugbar...`);
                        await runLocalShell({
                            command: 'php artisan debugbar:clear',
                            ignore_stdout: true,
                            on_error: 'ignore'
                        });
                    }
                },
                build: async (pm = 'bun', dist = 'public/build') => {
                    logInfo(`\n-> LOCAL: Deleting ${dist}`);
                    fs.rmSync(dist, { recursive: true, force: true });

                    await runLocalShell({
                        message: `blue|\n-> LOCAL: ${pm} run build`,
                        command: process.platform !== 'win32'
                            ? `${pm} run build || exit 1;`
                            : `${pm} run build`,
                        ignore_stdout: true,
                        on_error: 'throw'
                    });
                },
            },

            server: {
                optimize: async (sshConn: TSshConnect, cfg?: Omit<ShellProps, 'command'>) => {
                    await sshConn.exec({
                        command: 'php artisan optimize',
                        message: cfg?.message ?? ((p, log) => log(`\n-> SSH: Running 'php artisan optimize'`, 'blue')),
                        on_error: cfg?.on_error ?? 'print',
                        ignore_stdout: cfg?.ignore_stdout ?? true
                    });
                },

                composerUpdate: async (sshConn: TSshConnect, cfg?: Omit<ShellProps, 'command'>) => {
                    await sshConn.exec({
                        command: 'export COMPOSER_ALLOW_SUPERUSER=1 && composer update --optimize-autoloader --no-interaction --no-dev --prefer-dist',
                        message: cfg?.message ?? 'blue|\n-> SSH: composer update non-dev dependecies',
                        on_error: cfg?.on_error ?? 'print',
                        ignore_stdout: cfg?.ignore_stdout ?? true
                    });
                },

                ensureDirsExist: async (sshConn: TSshConnect, opts: { dirs: string[], owner?: string, group?: string, permissions?: string }) => {
                    const permissions = opts.permissions ?? '0755';
                    const owner = opts.owner ?? 'www';
                    const group = opts.group ?? 'www';
                    for (const dir of opts.dirs) {
                        await sshConn.exec({
                            command: `install -d -m ${permissions} -o ${owner} -g ${group} ${dir}`,
                            message: `blue|\n-> SSH: Making sure '${dir}' exists on server with permissions ${permissions} and owner ${owner}:${group}`,
                            on_error: 'ignore'
                        });
                    }
                }
            },

        }),
        exec: runLocalShell,
        compressFiles: (files: TFileToUpload[]) => {
            const zip = new AdmZip();
            for (const f of files) {
                zip.addFile(f.trimmedPath, fs.readFileSync(f.fullPath));
            }

            // const buffer = await zip.toBuffer()
            const zipPath = fsPath.join(userConfig.sourceBasePath, consts.zipFileName);
            logInfo(`\n-> LOCAL: Creating '${zipPath}'.`);
            fs.writeFileSync(zipPath, zip.toBuffer());
            const zipSizeKB = fs.statSync(zipPath).size / 1024;
            let zipSizeStr = zipSizeKB < 1024
                ? zipSizeKB.toFixed(2) + ' KB'
                : (zipSizeKB / 1024).toFixed(2) + ' MB';
            logInfo(`\n-> LOCAL: Created '${zipPath}' (${zipSizeStr}).`);

            return {
                path: zipPath,
                deleteLocally: () => {
                    logInfo(`\n-> LOCAL: Deleting '${zipPath}'.`);
                    fs.rmSync(zipPath);
                },
                /**
                 * To use this function on a windows server, you need to have '7z' installed on it. 
                 * On unix servers, the built-in 'unzip' command is used.
                 * 
                 * If you want to use another unzipping method, you can use 'exec' function of the ssh connection to execute your preferred command.
                 * Or you can pass 'windowsServerUnzipCommand' in the userConfig.
                 */
                unzipOnServer: async (sshConn: TSshConnect) => {
                    await sshConn.unzip(consts.zipFileName);
                },
                deleteOnServer: async (sshConn: TSshConnect): Promise<void> => {
                    await sshConn.deleteFile(consts.zipFileName);
                },
            };
        },
        deleteLocalZip: () => {
            logInfo('\n-> LOCAL: Deleting the zip file...');
            fs.rmSync(fsPath.join(userConfig.sourceBasePath, consts.zipFileName));
        },
        deleteLocalFile: (path: string, prependBasePath = true) => {
            logInfo(`\n-> LOCAL: Deleting '${path}'...`);
            if (prependBasePath && !path.includes(userConfig.sourceBasePath))
                path = fsPath.join(userConfig.sourceBasePath, path);

            fs.rmSync(path);
        },
        deleteLocalDir: (path: string, prependBasePath = true) => {
            logInfo(`\n-> LOCAL: Deleting '${path}'...`);
            if (prependBasePath && !path.includes(userConfig.sourceBasePath))
                path = fsPath.join(userConfig.sourceBasePath, path);

            fs.rmdirSync(path, { recursive: true });
        },
        sleep: sleep,
        wait: sleep,
        finish: () => {
            const execTime = (performance.now() - startTime).toFixed(0);
            logSuccess(`\n🎉 FINISHED SUCCESSFULLY in ${execTime} ms 🎉`);
            console.log();
            process.exit(0);
        },
        exitIfDryRun: () => {
            if (flags.isDryRun) {
                logInfo('\n-> End of dry-run!');
                process.exit(0);
            }
        },
        log,
        logError,
        logWarning,
    }
}

export function compareServerFilesWithLocal(
    sourceBasePath: string,
    flags: TFlags,
    ignoreCfg: TIgnoreConfig,
    filesFromServer: TFileFromServer[],
    dirsWithManyFiles?: string[],
) {
    const ig = ignore().add(ignoreCfg.ignorePatterns);
    const newFiles: TFileToUpload[] = [];
    findInDir<TFileToUpload>({
        baseDir: sourceBasePath,
        onFound: (obj) => {
            newFiles.push(obj);
        },
        ignore: ig,
        ignorer: ignoreCfg.ignoreFn,
        objectCreator: (data) => {
            const { path: fullPath, trimmedPath, stat } = data;
            if (flags.isFresh) {
                return {
                    trimmedPath,
                    fullPath,
                    sizeInBytes: stat.size,
                };
            }

            const c = Math.round(stat.ctimeMs / 1000)
            const m = Math.round(stat.mtimeMs / 1000)
            const local: TFileFromServer = {
                path: fullPath,
                // ctimeEpoch: c,
                mtimeEpoch: m,
                size: stat.size,
            }
            const remote = filesFromServer.find(v => trimmedPath == trimPath(v.path, sourceBasePath));

            if (flags.isLogFiles) {
                log("\n- " + trimmedPath, 'blue');
            }
            if (!remote) {
                if (flags.isLogFiles)
                    log("     not found on server", 'blue');

                return {
                    trimmedPath,
                    fullPath,
                    sizeInBytes: stat.size
                };
            }

            if (fullPath.includes('.dll')) {
                // console.log(stat);
                // console.log(remote);
                // process.exit(1)
            }

            if (flags.isLogFiles) {
                const lm = local.mtimeEpoch;
                const rm = remote.mtimeEpoch;
                log("   server: " + rm + ' (' + unixTsToDate(rm) + ") - " + remote.size + ' bytes', 'blue');
                log("    local: " + lm + ' (' + unixTsToDate(lm) + ") - " + stat.size + ' bytes', 'blue');
                log("     diff: " + Math.round((lm - rm)) + 's ' + Math.round((lm - rm) / 60) + 'm ' + Math.round((lm - rm) / 60 / 60) + 'h', 'blue');
            }
            if (!shouldUpload(local, remote)) {
                if (flags.isLogFiles)
                    log("   upload: false", 'red');
                return null;
            }

            if (flags.isLogFiles)
                log("   upload: true", 'green');

            return {
                trimmedPath,
                fullPath,
                sizeInBytes: stat.size,
            };
        }
    })

    if (dirsWithManyFiles !== undefined) {
        const distDirsPrinted: Record<string, boolean> = (dirsWithManyFiles ?? [])
            .reduce((obj, val) => ({ ...obj, [normalizePath(val)]: false }), {});

        log('\nFILES TO UPLOAD:');

        let maxLen = 0;
        let totalSize = 0;
        for (const f of newFiles) {
            let printed = false;
            for (const distDir in distDirsPrinted) {
                if (!f.trimmedPath.startsWith(distDir))
                    continue;
                maxLen = Math.max(maxLen, distDir.length + 3);
                printed = true;
            }
            if (!printed) {
                maxLen = Math.max(maxLen, f.trimmedPath.length);
            }
        }
        maxLen += 5;
        for (const f of newFiles) {
            let printed = false;
            for (const distDir in distDirsPrinted) {
                if (!f.trimmedPath.startsWith(distDir))
                    continue;

                if (!distDirsPrinted[distDir]) {
                    const totalSize = newFiles
                        .filter(t => t.trimmedPath.startsWith(distDir))
                        .reduce((acc, t) => acc + t.sizeInBytes, 1);
                    const path = `${distDir}/**`.padEnd(maxLen);
                    logSuccess(`- ${path} ${bytesToSizeStr(totalSize).padStart(8)}`);
                    distDirsPrinted[distDir] = true;
                }
                printed = true;
            }
            if (!printed) {
                const path = f.trimmedPath.padEnd(maxLen);
                logSuccess(`- ${path} ${bytesToSizeStr(f.sizeInBytes).padStart(8)}`);
            }

            totalSize += f.sizeInBytes;
        }

        logSuccess('-'.repeat(maxLen + 11));
        logSuccess(`- ${`TOTAL (${newFiles.length} files)`.padEnd(maxLen)} ${bytesToSizeStr(totalSize).padStart(8)}`);
    }

    return newFiles;
}

function shouldUpload(local: TFileFromServer, remote: TFileFromServer) {
    if (local.size !== remote.size)
        return true;

    if (local.mtimeEpoch > remote.mtimeEpoch)
        return true;

    return false;
}