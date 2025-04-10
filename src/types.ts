import { NodeSSH } from "node-ssh";
import { ShellProps } from "./utils/cli_utils.ts";
import { TIgnoreConfig } from "./services/executer.ts";

export type OS = 'windows' | 'unix';
export type TOnError = 'throw' | 'print' | 'ignore'; // print: print but don't throw. (default: throw)

export type TFileToUpload = {
    // path without source directory. for printing purposes
    trimmedPath: string,
    // path starting from the source directory
    fullPath: string,
    sizeInBytes: number,
}
export type TFileFromServer = {
    path: string, // relative path from the base path
    mtimeEpoch: number, // seconds since Jan. 1, 1970, 00:00 GMT
    // ctimeEpoch: number,
    size: number, // in bytes
}

export type TFtpConfig = {
    host: string;
    base_path: string;
    username: string;
    password: string;
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