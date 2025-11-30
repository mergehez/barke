import AdmZip from "adm-zip";
import { SSHGetPutDirectoryOptions, SSHPutFilesOptions, Config as TSshConfig } from "node-ssh";
import fs from "node:fs";
import fsPath from "node:path";
import { SFTPWrapper, TransferOptions as SshTransferOptions } from "ssh2";
import { OS, TFileFromServer, TFileToUpload, TFtpConfig, TOnError, TStats } from "../types.ts";
import { runLocalShell, ShellProps, ShellPropsExtended } from "../utils/cli_utils.ts";
import { bytesToSizeStr, findInDir, log, logError, logInfo, logSuccess, logWarning, normalizePath, runCheckIgnore, runCheckIgnoreAsync, sleep, trimPath, unixTsToDate } from "../utils/helpers.ts";
import ignore from "../utils/ignore.ts";
import { TLSConnectionOptions, useFTP } from "./useFTP.ts";
import { sshConnect, TSshConnect } from "./useSSH.ts";

export const consts = {
    zipFileName: 'barke_deploy_archive.zip',
}

export type TUserConfig = {
    /**
     * The base path of your local project. All paths in the configuration are relative to this path.
     */
    sourceBasePath: string;
    /**
     * The base path of your project on the server. All paths in the configuration are relative to this path.
     * For example, if your project is located at '/var/www/myproject', set this to '/var/www/myproject'.
     */
    targetBasePath: string;
    /**
     * The operating system of the server. Use 'windows' for Windows servers and 'unix' for Linux/Unix/Mac servers.
     * This is important for determining the correct commands to use on the server.
     */
    targetOS: OS;
    /**
     * This is only for windows servers and is used in SSH mode.
     * If not provided, the default value is '7z x -aoa'.
     */
    windowsServerUnzipCommand?: string;
}

export type TIgnoreConfig = {
    /**
     * These patterns are used to ignore file while getting the list of remote files.
     * Local files are also ignored with these patterns when comparing.
     */
    ignorePatterns: string[],
    /**
     * This function is called after checking the 'ignorePatterns'. If you return 'true', that file won't be included.
     *
     * Just return false if 'ignorePatterns' is enough for you.
    */
    ignoreFn?: (path: string, stat: TStats) => boolean
}
export type TFindNewFilesConfig = TIgnoreConfig & {
    /**
     * If provided, console.log will group the files during 'findNewFiles' function.
     *
     * 
     * Example output:
     *```
     * FILES TO UPLOAD:
     * - file.txt               5.67 kb
     * - public/build/**        1.23 MB
     *```
     */
    dirsWithManyFiles?: string[]
}

export type TFlags = {
    /**
     * Indicates whether '--dry-run' flag is set.
     */
    isDryRun: boolean;
    /**
     * Indicates whether '--fresh' flag is set.
     */
    isFresh: boolean;
    /**
     * Indicates whether '--log-files' flag is set.
     */
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
        /**
         * Creates an SSH connection to the server and returns SSH related helper functions.
         */
        sshConnect: (sshConfig: TSshConfig) => sshConnect(userConfig, flags, sshConfig),

        /**
         * Creates an FTP connection to the server and returns FTP related helper functions.
         */
        ftpConnect: (ftpInfo: TFtpConfig, secureOptions?: TLSConnectionOptions) => useFTP(userConfig, flags, ftpInfo, secureOptions),

        /** This is only for windows servers. */
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

        /** Laravel specific helper functions for both local and server. */
        useLaravelHelpers: () => ({
            /** Local helper functions */
            local: {
                /** Runs 'php artisan optimize:clear' on the local machine. */
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

                /** Builds the frontend assets using the specified package manager. Runs e.g. 'bun run build' if pm is bun */
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

            /** Remote helper functions */
            server: {
                /** Runs 'php artisan optimize:clear' on the server. */
                optimize: async (sshConn: TSshConnect, cfg?: Omit<ShellProps, 'command'>) => {
                    await sshConn.exec({
                        command: 'php artisan optimize',
                        message: cfg?.message ?? ((p, log) => log(`\n-> SSH: Running 'php artisan optimize'`, 'blue')),
                        on_error: cfg?.on_error ?? 'print',
                        ignore_stdout: cfg?.ignore_stdout ?? true
                    });
                },

                /** Runs 'composer update --optimize-autoloader --no-interaction --no-dev --prefer-dist' on the server. */
                composerUpdate: async (sshConn: TSshConnect, cfg?: Omit<ShellProps, 'command'>) => {
                    await sshConn.exec({
                        command: 'export COMPOSER_ALLOW_SUPERUSER=1 && composer update --optimize-autoloader --no-interaction --no-dev --prefer-dist',
                        message: cfg?.message ?? 'blue|\n-> SSH: composer update non-dev dependecies',
                        on_error: cfg?.on_error ?? 'print',
                        ignore_stdout: cfg?.ignore_stdout ?? true
                    });
                },

                /** Ensures that the given directories exist on the server with the given owner, group and permissions. */
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

        /**
         * Runs a shell command on the local machine.
         */
        exec: runLocalShell,

        /**
         * Compresses the given files into a zip file and returns the path of the zip file.
         * Also provides functions to delete the zip file locally and on the server, and to unzip the file on the server.
         * @param files Typically the output of 'findNewFiles' function from SSH or FTP connections.
         */
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
                /** The path of the zip file on the local machine. */
                path: zipPath,

                /** Function to delete the zip file on the local machine. */
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

                /** Function to delete the zip file on the server. */
                deleteOnServer: async (sshConn: TSshConnect, onError?: TOnError): Promise<void> => {
                    runCheckIgnoreAsync(async () => await sshConn.deleteFile(consts.zipFileName), onError);
                },
            };
        },

        /**
         * Deletes zip file generated by 'compressFiles' function. (barke_deploy_archive.zip)
         * @param onError What to do on error. Default is to throw the error.
         */
        deleteLocalZip: (onError?: TOnError) => {
            logInfo('\n-> LOCAL: Deleting the zip file...');
            runCheckIgnore(() => fs.rmSync(fsPath.join(userConfig.sourceBasePath, consts.zipFileName)), onError);
        },

        /**
         * Deletes a file on the local machine. The path is relative to 'sourceBasePath' by default.
         * @param path The path of the file to delete.
         * @param prependBasePath If true, 'sourceBasePath' is prepended to the path. Default is true.
         * @param onError What to do on error. Default is to throw the error.
         */
        deleteLocalFile: (path: string, prependBasePath = true, onError?: TOnError) => {
            logInfo(`\n-> LOCAL: Deleting '${path}'...`);
            if (prependBasePath && !path.includes(userConfig.sourceBasePath))
                path = fsPath.join(userConfig.sourceBasePath, path);

            runCheckIgnore(() => fs.rmSync(path), onError);
        },

        /**
         * Deletes a directory on the local machine. The path is relative to 'sourceBasePath' by default.
         * @param path The path of the directory to delete.
         * @param prependBasePath If true, 'sourceBasePath' is prepended to the path. Default is true.
         * @param onError What to do on error. Default is to throw the error.
         */
        deleteLocalDir: (path: string, prependBasePath = true, onError?: TOnError) => {
            logInfo(`\n-> LOCAL: Deleting '${path}'...`);
            if (prependBasePath && !path.includes(userConfig.sourceBasePath))
                path = fsPath.join(userConfig.sourceBasePath, path);
            runCheckIgnore(() => fs.rmdirSync(path, { recursive: true }), onError);
        },

        /**
         * Sleeps for a given amount of time.
         * @param ms The amount of time to sleep, in milliseconds.
         */
        sleep: sleep,

        /**
         * Sleeps for a given amount of time.
         * @param ms The amount of time to sleep, in milliseconds.
         */
        wait: sleep,

        /**
         * Call this function at the point you want to finish the execution.
         * This function will print the total execution time and exit the process with code 0.
         */
        finish: () => {
            const execTime = (performance.now() - startTime).toFixed(0);
            logSuccess(`\n🎉 FINISHED SUCCESSFULLY in ${execTime} ms 🎉`);
            console.log();
            process.exit(0);
        },

        /**
         * If '--dry-run' flag is set, this function will print a message and exit the process with code 0.
         * Call this function after all the preparations and before any action that changes anything.
         */
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