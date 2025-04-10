import { readFileSync, rmSync, writeFile, writeFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import os from 'os';
import path from "path";
import { PlatformServerUtils, TFileFromServer } from "../types.ts";
import { runShell } from "../utils/cli_utils.ts";
import { TUserConfig } from "./executer.ts";

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
export const useWindowsUtils = (cfg: TUserConfig, ssh: NodeSSH): PlatformServerUtils => {
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
            const psFile = 'list_site_files.ps1';
            const fileExists = await runShell({
                command: `if exist ${psFile} (echo 1) else (echo 0)`,
                message: `blue|\n-> SSH: checking if ${psFile} exists...`,
                ignore_stdout: true
            }, true);
            
            if (fileExists.trim() !== '1') {
                const tempFileName = `temp_${path.basename(psFile)}_${Date.now()}`;
                const localTempPath = path.join(os.tmpdir(), tempFileName);
            
                console.log(`blue|\n-> Creating temporary local file: ${localTempPath}`);
                writeFileSync(localTempPath, psFileContent.replace(/\r?\n/g, '\r\n'), { encoding: 'utf8' });
                
                const remoteFilePath = path.join(cfg.targetBasePath, psFile);
                await ssh.putFile(localTempPath, remoteFilePath)
            
                console.log(`blue|\n-> Created remote file: ${remoteFilePath}. Deleting local temp file...`);
                // Delete the local temp file
                rmSync(localTempPath, { force: true });
                console.log(`blue|\n-> Deleted local temp file: ${localTempPath}`);   
            }
            
            const cmd = `powershell.exe -ExecutionPolicy Bypass -File ${psFile} -site '' -ignored_dirs 'wwwroot/build,logs'`;
            let filesFromServer: TFileFromServer[] = [];

            // const cmd2 = 'for /D %D in ("%SystemDrive%\*.*") do @if /I not "%D"=="%SystemRoot%" pushd "%D" & (for /R %F in ("*.doc?") do @if %~zF LEQ 50000000 echo %F) & popd';
''          // @echo off & for /D %D in ("C:\inetpub\wwwroot\*.*") do echo %D 
            // const cmd = 'forfiles /s /m * /c "cmd /c echo {\\"path\\":@relpath, \\"mtime\\": \\"@fdate @ftime\\", \\"size\\": @fsize, \\"isDir\\": @isdir},"';

            let jsonStr = await runShell({
                command: cmd,
                message: 'blue|\n-> SSH: fetching file info from server...',
                ignore_stdout: false,
                on_error: 'print'
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
                    // const [datePart, timePart] = r.mtime.split(" ");
                    // const [day, month, year] = datePart.split(".");
                    // const mtime = new Date(`${year}-${month}-${day}T${timePart}.000${serverGmtOffsett}`).getTime() / 1000;
 
                    filesFromServer.push({
                        path: r.path.trim(),
                        mtimeEpoch: r.mtime,
                        // ctimeEpoch: 0,
                        size: r.size,
                    });
                }
                // console.log('filesFromServer:', filesFromServer.length);
                
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


const psFileContent = `<#
.SYNOPSIS
Lists files recursively within a specified site directory under C:\\inetpub\\wwwroot,
excluding specified subfolders, and outputs details for each file as a JSON fragment
ending with a comma. Compatible with PowerShell 4.0.

.DESCRIPTION
This script performs the following actions:
1. Accepts the target site directory name and comma-delimited exclusion directories as parameters.
2. Determines the base path as C:\\inetpub\\wwwroot\\[site].
3. Parses the comma-delimited exclusion string into an array.
4. Constructs absolute paths for the directories to be excluded relative to the site path.
5. Recursively finds all files (-File) within the site's base path.
6. Filters out any files located within the specified exclusion folders.
7. For each remaining file, calculates:
    - Relative path (starting with './', using forward slashes '/').
    - Modification time as a Unix timestamp (seconds since epoch, UTC).
    - File size in bytes.
8. Formats this information as a compressed JSON object string.
9. Prints the JSON string followed by a comma to standard output.

.PARAMETER site
The name of the target site's subdirectory under C:\\inetpub\\wwwroot (e.g., 'my-site'). Mandatory.
Quotes around the value will be automatically trimmed.

.PARAMETER ignored_dirs
A comma-delimited string of directory paths to ignore, relative to the site directory
(e.g., 'wwwroot\\build,build\\assets'). Mandatory.

.EXAMPLE
powershell.exe -ExecutionPolicy Bypass -File C:\\inetpub\\wwwroot\\list_site_files.ps1 -site 'my-site' -ignored_dirs 'wwwroot\\build,logs'

.NOTES
- Designed for PowerShell 4.0 compatibility.
- Assumes the script itself is located in C:\\inetpub\\wwwroot.
- Timestamp is in UTC for Unix epoch calculation.
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$site,

    [Parameter(Mandatory=$true)]
    [string]$ignored_dirs
)

# --- Script Body ---
    # Trim leading/trailing quotes from input parameters
    $site = $site.Trim(" '\`"")
    $ignored_dirs = $ignored_dirs.Trim(" '\`"")

    # Determine the directory where the script itself resides (should be C:\\inetpub\\wwwroot)
    $scriptRoot = $PSScriptRoot

    # Construct the base path for the target site directory using the cleaned site name
    $basePath = Join-Path -Path $scriptRoot -ChildPath $site -Resolve:$false

    # Check if the target site directory actually exists
    if (-not (Test-Path -Path $basePath -PathType Container)) {
        Write-Error "Target site directory not found: $basePath"
        exit 1
    }

    # Ensure basePath does not end with a backslash for cleaner path manipulation later
    # CORRECTED LINE: Escaped backslash for TrimEnd argument
    $basePath = $basePath.TrimEnd('\\')

    # Parse the comma-delimited ignored directories string into an array
    $relativeExclusions = $ignored_dirs.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

    # Construct the full, absolute paths for the directories to be excluded
    $absoluteExclusionPaths = $relativeExclusions | ForEach-Object { Join-Path -Path $basePath -ChildPath $_ }

    # --- Define Unix Epoch manually using New-Object for PSv4 compatibility ---
    # Use New-Object to call the DateTime constructor with specific arguments
    $unixEpochDateArgs = @(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    $unixEpochDate = New-Object -TypeName System.DateTime -ArgumentList $unixEpochDateArgs

    # Get all files recursively, starting from the site's base path
    Get-ChildItem -Path $basePath -Recurse -File -ErrorAction Stop |
        # Filter out files whose full path starts with one of the excluded directory paths
        Where-Object {
            $itemFullName = $_.FullName
            $isExcluded = $false
            foreach ($excludePath in $absoluteExclusionPaths) {
                # CORRECTED LINE: Escaped backslash for -like comparison string
                if ($itemFullName -like ($excludePath + '\\*')) {
                    $isExcluded = $true
                    break
                }
            }
            -not $isExcluded
        } |
        # Process and format each remaining file
        ForEach-Object {
            # Calculate relative path with respect to the site's base path
            # CORRECTED LINE: Escaped backslash for TrimStart and Replace arguments
            $relativePath = $_.FullName.Substring($basePath.Length).TrimStart('\\').Replace('\\','/')
            $relativePath = "./" + $relativePath

            # --- Calculate MTime using DateTime subtraction and TimeSpan.TotalSeconds ---
            $fileTimeUtc = $_.LastWriteTimeUtc # This is a DateTime object, Kind should be Utc

            # Subtract the manually defined UTC epoch DateTime from the file's UTC DateTime
            $timeSpan = $fileTimeUtc.Subtract($unixEpochDate)

            # Get the total seconds from the resulting TimeSpan and cast to Int64
            # Use [Math]::Floor to ensure we truncate any fractional seconds before casting
            $mtimeUnix = [int64][Math]::Floor($timeSpan.TotalSeconds)

            # Create a PowerShell custom object with the desired properties
            # Note: [PSCustomObject] requires PS 3.0+ (PS 4.0 is fine)
            $fileObject = [PSCustomObject]@{
                path  = $relativePath
                mtime = $mtimeUnix
                size  = $_.Length
                isDir = $false
            }

            # Convert the single object to a compressed JSON string
            $jsonOutput = $fileObject | ConvertTo-Json -Compress -Depth 5

            # Write the resulting JSON fragment line followed by a comma to standard output
            Write-Host ($jsonOutput + ",")
        }
# Script finished successfully
exit 0
`;
// writeFileSync(localTempPath, psFileContent.replace(/\r?\n/g, '\r\n'), { encoding: 'utf8' });