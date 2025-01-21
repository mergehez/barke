import { TUserConfig } from "./executer.ts";
import { PlatformServerUtils, TFileFromServer } from "../types.ts";
import { runLocalShell } from "../utils/cli_utils.ts";


export const unixConsts = () => {
    const res: Omit<PlatformServerUtils, 'sshPrependCdToCommand' | 'sshGetFilesFromServer'> = {
        eol: '\n',
        time: {
            gmtOffsett: '', // like '+0200'
            calculateGMTOffset: async () => {
                const gmtOffsett = (await runLocalShell({ command: 'date +%z', ignore_stdout: true }))
                    .split(res.eol)
                    .filter(t => t.trim())[0]
                    .trim();
                res.time.gmtOffsett = gmtOffsett
            },
        },
        sshUnzipCommand: 'unzip -o',
        sshDeleteCommand: 'rm',
        sshDeleteDirCommand: 'rm -r',
    };
    return res;
}
export const useUnixUtils = (cfg: TUserConfig): PlatformServerUtils => {
    return {
        ...unixConsts(),
        sshPrependCdToCommand: (cmd: string, toPrepend: string): string => {
            return `cd ${toPrepend} || { echo "'${toPrepend}' doesn't exist"; exit 1; }; ${cmd}`
        },
        sshGetFilesFromServer: async (igCfg, serverGmtOffsett, runShell) => {
            let filesFromServer: TFileFromServer[] = [];
            let cmd = `find `;
            for (const ignore of igCfg.ignorePatterns) {
                if (ignore == '/.*' || ignore == '/*.*')
                    continue;
                let i = ignore.startsWith('/') ? '.' + ignore : ignore;
                if (i.endsWith('/'))
                    i = i.substring(0, i.length - 1);
                cmd += `-not \\( -path "${i}" -prune \\) `;
            }
            // example output: {"path":"/path/to/file.txt", "ctime": 1672531200, "mtime": 1672531201, "size": 1024}
            // @ in printf is seconds since Jan. 1, 1970, 00:00 GMT
            cmd += `-type f -printf '{"path":"%p", "ctime": %C@, "mtime": %T@, "size": %s},\\n' | awk '{sub(/\\.[0-9]+/, "", $3); sub(/\\.[0-9]+/, "", $5); print $0 }'`;
            const jsonStr = await runShell({
                command: cmd,
                message: 'blue|\n-> SSH: Fetching file info from server...',
                ignore_stdout: true
            }, true);

            try {
                const res = JSON.parse('[' + jsonStr.substring(0, jsonStr.length - 1) + ']');
                for (const r of res) {
                    filesFromServer.push({
                        path: r.path,
                        mtimeEpoch: r.mtime,
                        // ctimeEpoch: r.ctime,
                        size: r.size,
                    });
                }
                return {
                    files: filesFromServer,
                    includesSeconds: true
                };
            }catch (e) {
                console.log('jsonStr:', jsonStr);
                console.log('e:', e);
                console.log('cmd:', cmd);
                throw e;
            }
        }
    }
}

