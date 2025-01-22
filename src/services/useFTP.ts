import { progressBar, logError, logInfo, logWarning, normalizePath } from "../utils/helpers.ts";
import ignore from "../utils/ignore.ts";
import { TFileFromServer, TFtpConfig } from "../types.ts";
import fsPath from "node:path";
import { Client as FtpClient, UploadOptions as FtpUploadOptions, FileInfo as FtpFileInfo, FTPError } from "basic-ftp"
import tls from "tls";
import { compareServerFilesWithLocal, TFindNewFilesConfig, TFlags, TUserConfig } from "./executer.ts";

export type TLSConnectionOptions = tls.ConnectionOptions;
export type TFtpConnect = Awaited<ReturnType<typeof useFTP>>;

function trySetNotParsedModifiedAt(file: FtpFileInfo) {
    if(!file.modifiedAt && !file.isDirectory){
        // rawModifiedAt: "Jan 21 19:07",
        const regex = /(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2})/;
        const match = file.rawModifiedAt.match(regex);
        if(match){
            const [_, month, day, hour, minute] = match;
            const date = new Date();
            date.setMonth(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(month));
            date.setDate(parseInt(day));
            date.setHours(parseInt(hour));
            date.setMinutes(parseInt(minute));
            const toLocalTz = date.getTime() - date.getTimezoneOffset() * 60 * 1000;
            file.modifiedAt = new Date(toLocalTz);
        }
    }
}


export const useFTP = async (userConfig: TUserConfig, flags: TFlags, ftpInfo: TFtpConfig, secureOptions?: TLSConnectionOptions) => {
    const ftpClient = new FtpClient();
    try {
        logInfo('\n-> FTP: Connecting to the server...');
        await ftpClient.access({
            host: ftpInfo.host,
            user: ftpInfo.username,
            password: ftpInfo.password,
            secure: ftpInfo.secure ?? false,
            secureOptions: secureOptions,
        });
        logInfo('\n-> FTP: Connected successfully!');
    }
    catch (err) {
        logError(err);
        process.exit(1);
    }

    type TryCatchOptions = {
        fn: () => Promise<any>,
        onFtpError: (err: FTPError) => boolean, // when false, dont logError and dont exit
        onOtherError?: (err: unknown) => void
        cdToBase?: boolean
    }
    async function tryCatch(opts: TryCatchOptions) {
        if(opts.cdToBase)
            await ftpClient.cd('/');
        try {
            await opts.fn();
        } catch (error) {
            if(error instanceof FTPError){
                if(!opts.onFtpError(error))
                    return;
                logError(error);
                process.exit(1);
            }
            if(opts.onOtherError)
                opts.onOtherError(error);
            else
                throw error;
        }
    }

    async function getFilesRecursive(folder: string, arr: FtpFileInfo[], ignorer?: (folder: string, file: FtpFileInfo) => boolean) {
        for (const file of await ftpClient.list(folder)) {
            if (ignorer && ignorer(folder, file))
                continue;
            if (file.isDirectory) {
                // await getFilesRecursive(file.name)
                await getFilesRecursive(fsPath.join(folder, file.name), arr, ignorer)
            }
            else if (file.isFile) {
                // console.log(file.name)
                arr.push(file)
            }
        }
        return arr
    }

    async function serverFindNewFiles(cfg: TFindNewFilesConfig) {
        let filesFromServer: TFileFromServer[] = [];

        if (!flags.isFresh) {
            logInfo('\n-> FTP: fetching file info from FTP server...');
            const arr: FtpFileInfo[] = [];
            const ig = ignore().add(cfg.ignorePatterns);
            let folderAfterFtpBase = userConfig.targetBasePath.substring(ftpInfo.base_path.length);
            if(folderAfterFtpBase.startsWith('/'))
                folderAfterFtpBase = folderAfterFtpBase.substring(1);
            await getFilesRecursive(folderAfterFtpBase, arr, (folder: string, file: FtpFileInfo) => {
                let path = normalizePath(fsPath.join(folder, file.name), false);
                if(path.startsWith(folderAfterFtpBase))
                    path = path.substring(folderAfterFtpBase.length);
                if(path.startsWith('/'))
                    path = path.substring(1);
                // fsPath.relative('/', path);
                // const path = fsPath.join(folder, file.name);
                // console.log(folderAfterFtpBase, path)
                try {
                    trySetNotParsedModifiedAt(file);
                    const stats = {
                        size: file.size, 
                        mtime: file.modifiedAt,
                        mtimeMs: file.modifiedAt?.getTime(),
                        isDirectory: () => file.isDirectory,
                        isSymbolicLink: () => file.isSymbolicLink,
                        isFile: () => file.isFile,
                    }
                    const res =  cfg.ignoreFn(path, stats) || ig.ignores(path);
                    if(!res && !file.isDirectory){
                        filesFromServer.push({
                            mtimeEpoch: Math.round(stats.mtimeMs! / 1000),
                            size: stats.size,
                            path: path,
                        });
                    }
                    // console.log(res ? 'ignored' : 'not ignored')
                    return res;
                } catch (error) {
                    console.log(path, file)
                    throw error;
                }
            });
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


    function normalizeRemotePath(sourcePath: string, remotePath?: string) {
        remotePath = remotePath ?? fsPath.join(userConfig.targetBasePath, sourcePath);
        if (remotePath === sourcePath)
            remotePath = fsPath.join(userConfig.targetBasePath, sourcePath);
        if (remotePath.startsWith(ftpInfo.base_path))
            remotePath = remotePath.substring(ftpInfo.base_path.length);
        if (remotePath.startsWith('/'))
            remotePath = remotePath.substring(1);
        return remotePath;
    }

    async function uploadFrom(sourcePath: string, remotePath?: string, options?: FtpUploadOptions, shouldEnsureDir?: (dir: string) => boolean) {
        if (!sourcePath.startsWith(userConfig.sourceBasePath))
            sourcePath = fsPath.join(userConfig.sourceBasePath, sourcePath)
        sourcePath = sourcePath.replace('//', '/');
        remotePath = normalizeRemotePath(sourcePath, remotePath);

        const remoteDir = fsPath.dirname(remotePath);
        if (!shouldEnsureDir || shouldEnsureDir(remoteDir)) {
            await ftpClient.ensureDir(remoteDir);
            await ftpClient.cd('/');
            // remotePath = fsPath.basename(remotePath);
        }
        try {
            return await ftpClient.uploadFrom(sourcePath, remotePath, options)
        } catch (err) {
            logInfo(`\n-> FTP: Failed to upload '${sourcePath}' to '${await ftpClient.pwd()}/${remotePath}' on the server...`);
            throw err;
        }
    }
    return {
        client: ftpClient,
        findNewFiles: (cfg: TFindNewFilesConfig) => serverFindNewFiles(cfg),
        uploadFile: async (localFile: string, remoteFile?: string, options?: FtpUploadOptions) => {
            logInfo(`\n-> FTP: Uploading '${localFile}' to '${remoteFile}' on the server...`);
            await ftpClient.cd('/');
            return uploadFrom(localFile, remoteFile, options);
        },
        uploadFiles: async (files: string[], options?: FtpUploadOptions) => {
            logInfo(`\n-> FTP: Uploading files to the server...`);
            if (files.length == 0)
                return;
            await ftpClient.cd('/');
            const responses = [];
            const ensuredDirs = new Set<string>()
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const res = await uploadFrom(file, undefined, options, dir => {
                    const should = !ensuredDirs.has(dir);
                    ensuredDirs.add(dir);
                    return should;
                });
                const progress = Math.round((i + 1) / files.length * 100);
                progressBar.play(progress, `(${i + 1}/${files.length})`);
                responses.push(res);
            }
            progressBar.clear();
            return responses;
        },
        uploadDirectory: async (localDir: string, remoteDir: string) => {
            logInfo(`\n-> FTP: Uploading directory '${localDir}' to '${remoteDir}' on the server...`);
            remoteDir = normalizeRemotePath(remoteDir);
            await ftpClient.cd('/');
            await ftpClient.uploadFromDir(localDir, remoteDir);
        },
        deleteFile: async (remoteFile: string, ignoreErrorCodes?: boolean) => {
            logInfo(`\n-> FTP: Deleting the file '${remoteFile}' on the server...`);
            tryCatch({
                cdToBase: true,
                fn: async () => await ftpClient.remove(normalizeRemotePath(remoteFile), ignoreErrorCodes),
                onFtpError: (err) => {
                    if(err.message.includes('No such file or directory')){
                        logWarning(`     -  The directory '${remoteFile}' does not exist on the server.`);
                        return false;
                    }
                    return true;
                }
            })
        },
        deleteDir: async (remoteDir: string) => {
            logInfo(`\n-> FTP: Deleting the directory '${remoteDir}' on the server...`);
            tryCatch({
                cdToBase: true,
                fn: async () => await ftpClient.removeDir(normalizeRemotePath(remoteDir)),
                onFtpError: (err) => {
                    if(err.message.includes('No such file or directory')){
                        logWarning(`     -  The directory '${remoteDir}' does not exist on the server.`);
                        return false;
                    }
                    return true;
                }
            })
        },
        makeDir: async (remoteDir: string) => {
            logInfo(`\n-> FTP: Creating the directory '${remoteDir}' on the server...`);
            remoteDir = normalizeRemotePath(remoteDir);
            await ftpClient.cd('/');
            await ftpClient.ensureDir(remoteDir);
            await ftpClient.cd('/');
        },
        getFiles: async (remoteDir: string) => {
            logInfo(`\n-> FTP: Getting the files from the directory '${remoteDir}' on the server...`);
            remoteDir = normalizeRemotePath(remoteDir);
            await ftpClient.cd('/');
            return await ftpClient.list(remoteDir);
        },
        getFilesRecursive: async (remoteDir: string, ignore?: (folder: string, file: FtpFileInfo) => boolean) => {
            logInfo(`\n-> FTP: Getting the files recursively from the directory '${remoteDir}' on the server...`);
            remoteDir = normalizeRemotePath(remoteDir);
            await ftpClient.cd('/');
            const arr: FtpFileInfo[] = [];
            await getFilesRecursive(remoteDir, arr, ignore);
            return arr;
        },
        dispose: () => ftpClient.close(),
    }
}