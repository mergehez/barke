import { NodeSSH } from "node-ssh";
import { TIgnoreConfig } from "./services/executer.ts";
import { ShellProps } from "./utils/cli_utils.ts";

export type OS = 'windows' | 'unix';
/**
 * What to do on error.
 * - 'throw': throw the error (default)
 * - 'print': print the error but don't throw.
 * - 'ignore': ignore the error completely.
 */
export type TOnError = 'throw' | 'print' | 'ignore'; 

export type TFileToUpload = {
    /** path without source directory. for printing purposes */
    trimmedPath: string,
    /** path without source directory */
    fullPath: string,
    sizeInBytes: number,
}
export type TFileFromServer = {
    /** path without base path */
    path: string,
    /** last modified time (epoch, seconds since Jan. 1, 1970, 00:00 GMT) */
    mtimeEpoch: number,
    // ctimeEpoch: number,
    /** Size in bytes */
    size: number,
    /** Content hash (MD5) when content based comparison is used. */
    hash?: string,
}

export type TFtpConfig = {
    /** The FTP server host. IP address or hostname */
    host: string;
    /** base path on the FTP server */
    base_path: string;
    username: string;
    password: string;
    /** Whether to use a secure connection (FTPS) */
    secure?: boolean;
}

export type PlatformServerUtils = {
    sshPrependCdToCommand: (cmd: string, toPrepend: string) => string,
    eol: string,
    time: { 
        gmtOffsett: string; // like '+0200'
        // tzDiffCommand: string; 
        calculateGMTOffset: (ssh?: NodeSSH) => Promise<void>;
    },
    sshDeleteCommand: string,
    sshDeleteDirCommand: string,
    sshUnzipCommand: string,
    sshGetFilesFromServer: (igCfg: TIgnoreConfig, serverGmtOffsett: string, runShell: (cfg: ShellProps, prependCd?: boolean) => Promise<string>) => Promise<{ files: TFileFromServer[], includesSeconds: boolean }>,
    /** Returns MD5 hashes for the given remote paths. Not available on every platform. */
    sshGetFileHashes?: (paths: string[], runShell: (cfg: ShellProps, prependCd?: boolean) => Promise<string>) => Promise<Record<string, string>>,
}

export type TStats = {
    isFile(): boolean;
    isDirectory(): boolean;
    // isBlockDevice(): boolean;
    // isCharacterDevice(): boolean;
    isSymbolicLink(): boolean;
    // isFIFO(): boolean;
    // isSocket(): boolean;
    // dev: number;
    // ino: number;
    // mode: number;
    // nlink: number;
    // uid: number;
    // gid: number;
    // rdev: number;
    size: number;
    // blksiXze: number;
    // blocks: number;
    atimeMs?: number;
    mtimeMs: number | undefined; // undefined if folder
    ctimeMs?: number;
    // birthtimeMs: number;
    atime?: Date;
    mtime: Date | undefined;  // undefined if folder
    ctime?: Date;
    birthtime?: Date;
}