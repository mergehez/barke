import { progressBar, logError, logInfo, bytesToSizeStr } from "../utils/helpers.ts";
import { NodeSSH, SSHGetPutDirectoryOptions, SSHPutFilesOptions } from "node-ssh";
import { quotify, runSshShell, ShellProps, ShellPropsExtended } from "../utils/cli_utils.ts";
import { TFileFromServer } from "../types.ts";
import { useWindowsUtils, windowConsts } from "./useWindowsUtils.ts";
import { useUnixUtils, unixConsts } from "./useUnixUtils.ts";
import { Config as TSshConfig } from 'node-ssh';
import fsPath from "node:path";
import { SFTPWrapper, TransferOptions as SshTransferOptions } from "ssh2";
import { compareServerFilesWithLocal, TFindNewFilesConfig, TFlags, TUserConfig } from "./executer.ts";
import { start } from "node:repl";

export type TSshConnect = Awaited<ReturnType<typeof sshConnect>>;
export const sshConnect = async (userConfig: TUserConfig, flags: TFlags, sshConfig: TSshConfig) => {
    // console.log(sshConfig)
    let ssh: NodeSSH;
    try {
        ssh = await new NodeSSH().connect(sshConfig);
    } catch (error) {
        if ((error as any).message?.includes('All configured authentication methods failed')) {
            logError('Invalid SSH credentials given!')
            process.exit(1);
        }
        throw error;
    }

    const serverUtils = userConfig.targetOS === 'windows'
        ? useWindowsUtils(userConfig)
        : useUnixUtils(userConfig);

    const exec = async (cfg: ShellPropsExtended, prependCd: boolean = true) => {
        const prependPath = prependCd ? userConfig.targetBasePath : '';
        const convertedCfg = {
            ...cfg,
            command: typeof cfg.command === 'object'
                ? Array.isArray(cfg.command)
                    ? cfg.command.join(' && ')
                    : userConfig.targetOS === 'windows'
                        ? cfg.command.windows
                        : cfg.command.unix
                : cfg.command
        }
        if (!prependPath || convertedCfg.command.startsWith('cd '))
            return await runSshShell(convertedCfg, ssh);
        convertedCfg.command = serverUtils.sshPrependCdToCommand(convertedCfg.command, prependPath);
        return await runSshShell(convertedCfg, ssh);
    };

    async function serverFindNewFiles(ssh: NodeSSH, cfg: TFindNewFilesConfig) {
        const localConsts = (process.platform === 'win32' ? windowConsts() : unixConsts());
        await localConsts.time.calculateGMTOffset();

        let filesFromServer: TFileFromServer[] = [];
        if (!flags.isFresh) {
            await serverUtils.time.calculateGMTOffset(ssh);
            if (flags.isLogFiles) {
                logInfo('local gmtOffsett: ' + localConsts.time.gmtOffsett);
                logInfo('server gmtOffsett: ' + serverUtils.time.gmtOffsett);
            }

            const { files } = await serverUtils.sshGetFilesFromServer(
                cfg,
                serverUtils.time.gmtOffsett,
                exec
            );
            filesFromServer = files;
        }

        const newFiles = compareServerFilesWithLocal(
            userConfig.sourceBasePath,
            flags,
            cfg,
            filesFromServer,
            cfg.dirsWithManyFiles
        );

        if (newFiles.length === 0) {
            logError('\n There is no new file!');
            process.exit();
        }

        return newFiles;
    }

    function getTransferOptions(transferOptions?: SshTransferOptions | null) {
        return {
            step: (transferred: number, nb: number, total: number) => {
                const progress = Math.round(transferred / total * 100);
                progressBar.play(progress, `(${bytesToSizeStr(transferred)}/${bytesToSizeStr(total)})`);
            },
            ...transferOptions
        }
    }

    return {
        client: ssh,
        exec: exec,
        findNewFiles: (cfg: TFindNewFilesConfig) => serverFindNewFiles(ssh, cfg),
        uploadFile: async (localFile: string, remoteFile?: string, givenSftp?: SFTPWrapper | null, transferOptions?: SshTransferOptions | null) => {
            logInfo(`\n-> SSH: Uploading '${localFile}' to the server...`);
            if (!remoteFile)
                remoteFile = fsPath.join(userConfig.targetBasePath, fsPath.basename(localFile));
            const hadStep = !!transferOptions?.step;
            const res = await ssh.putFile(localFile, remoteFile, givenSftp, getTransferOptions(transferOptions));
            if (!hadStep)
                progressBar.clear();
            return res;
        },
        uploadFiles: async (files: string[], options?: SSHPutFilesOptions) => {
            logInfo(`\n-> SSH: Uploading files to the server...`);
            if (files.length == 0)
                return;
            var convertedFiles = files.map((f: string) => ({
                local: f,
                remote: fsPath.join(userConfig.targetBasePath, fsPath.basename(f))
            }));
            options = options ?? {};
            const hadStep = !!options.transferOptions?.step;
            options.transferOptions ??= getTransferOptions(options.transferOptions);
            await ssh.putFiles(convertedFiles, options);
            if (!hadStep)
                progressBar.clear();
        },
        uploadFiles2: async (files: { local: string; remote: string; }[], options?: SSHPutFilesOptions) => {
            logInfo(`\n-> SSH: Uploading files to the server...`);
            if (files.length == 0)
                return;
            options = options ?? {};
            const hadStep = !!options.transferOptions?.step;
            options.transferOptions ??= getTransferOptions(options.transferOptions);
            await ssh.putFiles(files, options);
            if (!hadStep)
                progressBar.clear();
        },
        uploadDirectory: async (localDir: string, remoteDir: string, options?: SSHGetPutDirectoryOptions) => {
            logInfo(`\n-> SSH: Uploading directory '${localDir}' to '${remoteDir}' on the server...`);
            options = options ?? {};
            const hadStep = !!options.transferOptions?.step;
            options.transferOptions ??= getTransferOptions(options.transferOptions);
            const res = await ssh.putDirectory(localDir, remoteDir, options);
            if (!hadStep)
                progressBar.clear();
            return res;
        },
        deleteFile: async (path: string, cfg?: Omit<ShellProps, 'command'>, prependBasePath = true) => {
            if (!cfg || !cfg.message)
                logInfo(`\n-> SSH: Deleting '${path}' on the server...`);
            await exec({
                command: serverUtils.sshDeleteCommand + ' ' + quotify(path),
                ...cfg,
            }, prependBasePath)
        },
        deleteDir: async (path: string, cfg?: Omit<ShellProps, 'command'>, prependBasePath = true) => {
            if (!cfg || !cfg.message)
                logInfo(`\n-> SSH: Deleting '${path}' on the server...`);
            await exec({
                command: serverUtils.sshDeleteDirCommand + ' ' + quotify(path),
                ...cfg,
            }, prependBasePath)
        },
        unzip: async (path: string) => {
            logInfo(`\n-> SSH: Unzipping '${path}' on the server...`);
            await exec({ command: serverUtils.sshUnzipCommand + ' ' + path }, true);
        },
        /**
         * contains some common docker commands
         */
        docker: {
            getImages: async () => {
                logInfo(`\n-> SSH: Getting docker images...`);
                const str = await exec({ command: 'docker images --format json' });
                return JSON.parse(str.startsWith('[') ? str : ('[' + str + ']'));
            },
            listContainers: async () => {
                logInfo(`\n-> SSH: Listing docker containers...`);
                const str = await exec({ command: 'docker ps --format json' });
                return JSON.parse(str.startsWith('[') ? str : ('[' + str + ']'));
            },
            build: async (imageName: string) => {
                logInfo(`\n-> SSH: Building docker image...`);
                await exec({ command: 'docker build -t ' + imageName + ' .' });
            },
            stop: async (containerId: string) => {
                logInfo(`\n-> SSH: Stopping docker container '${containerId}'...`);
                await exec({ command: 'docker stop ' + containerId });
            },
            start: async (containerId: string) => {
                logInfo(`\n-> SSH: Starting docker container '${containerId}'...`);
                await exec({ command: 'docker start ' + containerId });
            },
            restart: async (containerId: string) => {
                logInfo(`\n-> SSH: Restarting docker container '${containerId}'...`);
                await exec({ command: 'docker restart ' + containerId });
            },
            removeContainer: async (containerId: string, force = false) => {
                logInfo(`\n-> SSH: Removing docker container '${containerId}'...`);
                await exec({ command: 'docker rm ' + containerId + (force ? ' --force' : '') });
            },
            removeImage: async (imageName: string, force = false) => {
                logInfo(`\n-> SSH: Removing docker image '${imageName}'...`);
                await exec({ command: 'docker rmi ' + imageName + (force ? ' --force' : '') });
            },
            run: async (opts: DockerRunOptions) => {
                let msg = `\n-> SSH: Running docker image '${opts.image}'...`;
                if (opts.container)
                    msg += ` in container '${opts.container}'`;
                if (opts.portPair)
                    msg += ` on port ${opts.portPair}`;
                logInfo(msg);

                let cmd = 'docker run';
                if (opts.detach) cmd += ' -d';
                if (opts.portPair) cmd += ` -p ${opts.portPair}`;
                if (opts.container) cmd += ` --name ${opts.container}`;
                if (opts.volume) cmd += ` -v ${opts.volume}`;
                if (opts.env) cmd += ` -e ${opts.env}`;
                if (opts.additonalOptions) cmd += ` ${opts.additonalOptions}`;
                cmd += ` ${opts.image}`;

                await exec({ command: cmd });
            },
            pull: async (imageName: string) => {
                logInfo(`\n-> SSH: Pulling docker image '${imageName}'...`);
                await exec({ command: 'docker pull ' + imageName });
            }
        },
        dispose: () => ssh.dispose(),
    }
};

type DockerRunOptions = {
    image: string;
    container?: string;
    detach?: boolean; // -d (Run container in background and print container ID)
    portPair?: `${string}:${string}`;
    volume?: string;
    env?: string;
    additonalOptions?: string;
}

// command: docker rmi dckr --force || true
// message: blue|\n-> remove old docker image

// command: cd /www/wwwroot/test && ls && docker build -t dckr .
// message: blue|\n-> create docker image

// command: docker rm dckrx --force || true
// message: blue|\n-> remove old docker container

// command: docker run -d -p 83:8080 --name dckrx -v /www/wwwroot/test/logs:/app/logs dckr:latest
// message: blue|\n-> run docker container

// command: docker start dckrx
// message: blue|\n-> start docker container