import { NodeSSH, SSHGetPutDirectoryOptions, SSHPutFilesOptions, Config as TSshConfig } from "node-ssh";
import fsPath from "node:path";
import { SFTPWrapper, TransferOptions as SshTransferOptions } from "ssh2";
import { TFileFromServer } from "../types.ts";
import { quotify, runSshShell, ShellProps, ShellPropsExtended } from "../utils/cli_utils.ts";
import { bytesToSizeStr, logError, logInfo, progressBar } from "../utils/helpers.ts";
import { compareServerFilesWithLocal, TFindNewFilesConfig, TFlags, TUserConfig } from "./executer.ts";
import { unixConsts, useUnixUtils } from "./useUnixUtils.ts";
import { useWindowsUtils, windowConsts } from "./useWindowsUtils.ts";

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
        ? useWindowsUtils(userConfig, ssh)
        : useUnixUtils(userConfig);

    /**
     * Executes a command on the server via SSH.
     */
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
        /**
         * The underlying SSH client (node-ssh instance).
         */
        client: ssh,
        exec,
        /**
         * Gets the list of files from the server ignoring the given patterns and compares them with local files to find new or changed files.
         */
        findNewFiles: (cfg: TFindNewFilesConfig) => serverFindNewFiles(ssh, cfg),

        /**
         * Uploads a file to the server.
         * 
         * @param localFile The local file path to upload. This must be relative to 'sourceBasePath'.
         * @param remoteFile The remote file path on the server. If not provided, the file will be uploaded to 'targetBasePath' with the same name.
         * @param givenSftp This is directly passed to 'node-ssh'. See its documentation for more info.
         * @param transferOptions Optional transfer options for the upload process (e.g., step callback for progress).
         * @returns A promise that resolves when the upload is complete.
         */
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

        /**
         * Uploads multiple files to the server. Use 'uploadFile' for more flexibility.
         * 
         * @param files An array of local file paths to upload. Each file path must be relative to 'sourceBasePath'.
         * @param options Optional upload options, including transfer options for progress tracking. These are directly passed to 'node-ssh'. See its documentation for more info.
         * @returns A promise that resolves when all files have been uploaded.
         */
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

        /**
         * Uploads a directory and its contents to the server. Use 'uploadFile' for more flexibility.
         * @param localDir The local directory path to upload. This must be relative to 'sourceBasePath'.
         * @param remoteDir The remote directory path on the server. If not provided, the directory will be uploaded to 'targetBasePath' with the same name.
         * @param options Optional upload options, including transfer options for progress tracking. These are directly passed to 'node-ssh'. See its documentation for more info.
         * @returns A promise that resolves when the upload is complete.
         */
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

        /**
         * Deletes a file on the server.
         * @param path The remote file path to delete. This can be relative to 'targetBasePath' or an absolute path.
         * @param cfg Optional configuration for command execution, including error handling and custom messages.
         * @param prependBasePath Whether to prepend 'targetBasePath' to the given file path. Default is true.
         */
        deleteFile: async (path: string, cfg?: Omit<ShellProps, 'command'>, prependBasePath = true) => {
            if (!cfg || !cfg.message)
                logInfo(`\n-> SSH: Deleting '${path}' on the server...`);
            await exec({
                command: serverUtils.sshDeleteCommand + ' ' + quotify(path),
                ...cfg,
            }, prependBasePath)
        },

        /**
         * Deletes a directory on the server.
         * @param path The remote directory path to delete. This can be relative to 'targetBasePath' or an absolute path.
         * @param cfg Optional configuration for command execution, including error handling and custom messages.
         * @param prependBasePath Whether to prepend 'targetBasePath' to the given directory path. Default is true.
         */
        deleteDir: async (path: string, cfg?: Omit<ShellProps, 'command'>, prependBasePath = true) => {
            if (!cfg || !cfg.message)
                logInfo(`\n-> SSH: Deleting '${path}' on the server...`);
            await exec({
                command: serverUtils.sshDeleteDirCommand + ' ' + quotify(path),
                ...cfg,
            }, prependBasePath)
        },

        /**
         * Unzips a zip file on the server. 
         * 
         * Note: To use this function on a windows server, you need to have '7z' installed on it.
         * @param path The remote zip file path to unzip. This can be relative to 'targetBasePath' or an absolute path.
         */
        unzip: async (path: string) => {
            logInfo(`\n-> SSH: Unzipping '${path}' on the server...`);
            await exec({ command: serverUtils.sshUnzipCommand + ' ' + path }, true);
        },
        /**
         * contains some common docker commands
         */
        docker: {
            /** Gets a list of docker images on the server. */
            getImages: async () => {
                logInfo(`\n-> SSH: Getting docker images...`);
                const str = await exec({ command: 'docker images --format json' });
                return JSON.parse(str.startsWith('[') ? str : ('[' + str + ']'));
            },

            /** Gets a list of docker containers on the server. */
            listContainers: async () => {
                logInfo(`\n-> SSH: Listing docker containers...`);
                const str = await exec({ command: 'docker ps --format json' });
                return JSON.parse(str.startsWith('[') ? str : ('[' + str + ']'));
            },

            /** Builds a docker image on the server. */
            build: async (imageName: string) => {
                logInfo(`\n-> SSH: Building docker image...`);
                await exec({ command: 'docker build -t ' + imageName + ' .' });
            },

            /** Stops a docker container on the server. */
            stop: async (containerId: string) => {
                logInfo(`\n-> SSH: Stopping docker container '${containerId}'...`);
                await exec({ command: 'docker stop ' + containerId });
            },

            /** Starts a docker container on the server. */
            start: async (containerId: string) => {
                logInfo(`\n-> SSH: Starting docker container '${containerId}'...`);
                await exec({ command: 'docker start ' + containerId });
            },

            /** Restarts a docker container on the server. */
            restart: async (containerId: string) => {
                logInfo(`\n-> SSH: Restarting docker container '${containerId}'...`);
                await exec({ command: 'docker restart ' + containerId });
            },

            /** Removes a docker container on the server. */
            removeContainer: async (containerId: string, force = false) => {
                logInfo(`\n-> SSH: Removing docker container '${containerId}'...`);
                await exec({ command: 'docker rm ' + containerId + (force ? ' --force' : '') });
            },

            /** Removes a docker image on the server. */
            removeImage: async (imageName: string, force = false) => {
                logInfo(`\n-> SSH: Removing docker image '${imageName}'...`);
                await exec({ command: 'docker rmi ' + imageName + (force ? ' --force' : '') });
            },

            /** Runs a docker image on the server. */
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
                if (opts.additionalOptions) cmd += ` ${opts.additionalOptions}`;
                cmd += ` ${opts.image}`;

                await exec({ command: cmd });
            },

            /** Pulls a docker image from a registry on the server. */
            pull: async (imageName: string) => {
                logInfo(`\n-> SSH: Pulling docker image '${imageName}'...`);
                await exec({ command: 'docker pull ' + imageName });
            }
        },

        /** Closes the SSH connection. */
        dispose: () => ssh.dispose(),
    }
};

type DockerRunOptions = {
    /** The name of the docker image to run. */
    image: string;

    /** (--name argument) The name of the docker container to run. (Optional) */
    container?: string;

    /** (-d flag) Whether to run the container in detached mode. (Default is false). */
    detach?: boolean; // -d (Run container in background and print container ID)

    /** (-p argument) The port mapping for the container. (Optional) */
    portPair?: `${string}:${string}`;

    /** (-v argument) The volume mapping for the container. (Optional) */
    volume?: string;

    /** (-e argument) Environment variables for the container. (Optional) */
    env?: string;

    /** Additional options to pass to the 'docker run' command. This is directly added to the command line. (Optional) */
    additionalOptions?: string;
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