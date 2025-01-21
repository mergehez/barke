import { PlatformServerUtils, TFileFromServer } from "../types.ts";
import { TUserConfig } from "./executer.ts";
import { runShell } from "../utils/cli_utils.ts";
import { NodeSSH } from "node-ssh";

// notes
// when dotnet build: ctime of files are set to now. (nuget caches the files, afterward they are no more updated)

export const windowConsts = () => {
    const res: Omit<PlatformServerUtils, 'sshPrependCdToCommand' | 'sshGetFilesFromServer'> = {
        eol: '\r\n',
        time: {
            gmtOffsett: '',
            calculateGMTOffset: async (ssh?: NodeSSH) => {
                // Description=(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien
                let desc = (await runShell({ 
                    command: 'wmic timezone get Description /value', // return how many minutes the timezone is before UTC. if returns 120, it means the timezone is UTC+2
                    ignore_stdout: true 
                }, ssh))
                    .split(res.eol)
                    .filter(t => t.trim())[0]
                    .trim();
                
                desc = desc.split('=(UTC')[1].split(')')[0];
                
                res.time.gmtOffsett = desc
            },
        },
        sshUnzipCommand: '7z x -aoa',
        sshDeleteCommand: 'del',
        sshDeleteDirCommand: 'rmdir /s /q',
    };

    return res;
}
export const useWindowsUtils = (cfg: TUserConfig): PlatformServerUtils => {
    const consts = windowConsts()
    if(cfg.windowsServerUnzipCommand){
        consts.sshUnzipCommand = cfg.windowsServerUnzipCommand;
    }
    return {
        ...consts,
        sshPrependCdToCommand: (cmd: string, toPrepend: string): string => {
            return `cd ${toPrepend} && ${cmd}`
        },
        sshGetFilesFromServer: async (igCfg, serverGmtOffsett, runShell) => {
            let filesFromServer: TFileFromServer[] = [];

            const cmd = 'forfiles /s /m * /c "cmd /c echo {\\"path\\":@relpath, \\"mtime\\": \\"@fdate @ftime\\", \\"size\\": @fsize, \\"isDir\\": @isdir},"';
            let jsonStr = await runShell({
                command: cmd,
                message: 'blue|\n-> SSH: fetching file info from server...',
                ignore_stdout: true
            }, true);
            try {
                // {"path":".\folder\index.html", "mtime": "17.01.2025 00:12:46", "size": 6, "isDir": FALSE}
                jsonStr = jsonStr.replace(/\\/g, '/');
                jsonStr = jsonStr.replace(/":\s*FALSE/g, '": false');
                jsonStr = jsonStr.replace(/":\s*TRUE/g, '": true');
                jsonStr = '[' + jsonStr.substring(0, jsonStr.length - 1) + ']';
                const res = JSON.parse(jsonStr);
                for (const r of res) {
                    if(r.isDir)
                        continue;

                    // "mtime": "22.11.2024 15:05:25"
                    const [datePart, timePart] = r.mtime.split(" ");
                    const [day, month, year] = datePart.split(".");
                    const mtime = new Date(`${year}-${month}-${day}T${timePart}.000${serverGmtOffsett}`).getTime() / 1000;
 
                    filesFromServer.push({
                        path: r.path.trim(),
                        mtimeEpoch: mtime,
                        // ctimeEpoch: 0,
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
        },
    }
}


