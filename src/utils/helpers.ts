import fs from 'node:fs';
import fsPath from "node:path";
import { styleText } from 'node:util';
import { TOnError } from '../types.ts';
import { Ignore } from "./ignore.ts";
import CallSite = NodeJS.CallSite;

/**
 * Normalizes the given path by:
 * - Replacing backslashes with forward slashes.
 * - Removing trailing slashes (except for root).
 * - Removing leading './' if present.
 * - Optionally removing leading '/' if not for FTP.
 * @param path The path to normalize.
 * @param forToFtp Whether to normalize the path for FTP (default: true).
 * @returns The normalized path.
 */
export const normalizePath = (path: string, forToFtp = true) => {
    path = path.trim().replace(/\\/gi, "/");
    if(!path || path == '.' || path == './*' || path == '*')
        path = '/';
    if(path.endsWith('*'))
        path = path.substring(0, path.length - 1);
    if(path.endsWith('/') && path.length > 1)
        path = path.substring(0, path.length - 1);
    if(forToFtp && path.startsWith('./') && path.length > 2)
        path = path.substring(2);
    if(!forToFtp && path.startsWith('/'))
        path = path.substring(1);
    return path;
};

/**
 * Trims the given path based on the basepath.
 * @param path The path to trim.
 * @param basepath The base path to trim from.
 * @returns The trimmed path.
 */
export const trimPath = (path: string, basepath: string) => {
    if(basepath == '.')
        basepath = './';
    // if(!basepath || basepath == '.' || basepath == './' || basepath == '/')
    if(!basepath)
        return path;
    
    if(basepath == './' && path.startsWith('./'))
        return path.substring(2);
    
    if(basepath == '/' && path.startsWith('/'))
        return path.substring(1);
    

    const p = fsPath.join('.', path.replace(/\\/gi, "/"));
    const b = fsPath.join('.', basepath.replace(/\\/gi, "/"));
    return p.startsWith(b)
        ? p.substring(b.length + 1)
        : p
}

type FindInDirOptsFileType = {
    path: string,
    trimmedPath: string,
    name: string,
    stat: fs.Stats
}
type FindInDirOpts<T extends Record<string, any>> = {
    /** The base directory to start searching */
    baseDir: string,
    /** The callback to call when a file is found. To exclude a file, return false/null from objectCreator function */
    onFound: (data: T) => void,
    /** This is called for each file found. It should return the object to be passed to onFound callback or null/false to exclude the file */
    objectCreator?: (data: FindInDirOptsFileType) => T | null,
    ignore?: Ignore,
    ignorer?: (path: string, stat: fs.Stats) => boolean,
    allowSymlinks?: boolean,
    firstBaseDir?: string, // used internally
}

/**
 * Find files in a directory and its subdirectories. (on local machine)
 */
export function findInDir<T extends Record<string, any> = FindInDirOptsFileType>(opts: FindInDirOpts<T>) : void{
    opts.baseDir = normalizePath(opts.baseDir);
    if(opts.baseDir == '/' || opts.baseDir == './')
        opts.baseDir = '.';
    else if(opts.baseDir.startsWith('/'))
        opts.baseDir = opts.baseDir.substring(1);
    opts.firstBaseDir ??= opts.baseDir;
    opts.objectCreator ??= t => t as unknown as T;
    // const dir = fsPath.join('.', opts.baseDir);
    let files: string[];
    try {
        files = fs.readdirSync(opts.baseDir);
    }catch (e){
        logError(e);
        process.exit(1);
    }
    for (const file of files) {
        let path = fsPath.join(opts.baseDir, file).replace(/\\/gi, "/");
        if(path[0] === "/" || path[0] === "\\")
            path = path.substring(1);

        const trimmedPath = path.includes('/') ?  trimPath(path, opts.firstBaseDir) : path;

        if (opts.ignore?.ignores(trimmedPath)){
            if(process.argv.includes('--log-files'))
                log("- " + path + " (was ignored by your config)", 'red');
            continue;
        }

        const stat = fs.lstatSync(path);
        if(opts.ignorer && opts.ignorer(trimmedPath, stat)){
            if(process.argv.includes('--log-files'))
                log("- " + path + " (was ignored by your config)", 'red');
            continue;
        }

        if (!opts.allowSymlinks && stat.isSymbolicLink())
            continue;

        // the directory was not excluded. so let's look inside it
        if (stat.isDirectory()) {
            findInDir({
                baseDir: path,
                onFound: opts.onFound,
                objectCreator: opts.objectCreator,
                ignore: opts.ignore,
                ignorer: opts.ignorer,
                firstBaseDir: opts.firstBaseDir,
                allowSymlinks: opts.allowSymlinks,
            });
        }else{
            const res = opts.objectCreator({
                path,
                trimmedPath,
                name: file,
                stat,
            });
            if(!res){
                continue;
            }
            opts.onFound(res);
        }
    }
}

/**
 * replace {{0}}, {{1}}... with the corresponding index in the args array
 */
export function stringFormat(str: string, args: string[]) {
    return str.replace(/{{(\d+)}}/g, (_, index) => args[index] || `{${index}}`);
}

/**
 * Trims the specified substrings from the given string.
 * @param str The original string to trim.
 * @param toTrim An array of substrings to remove from the original string.
 * @param where Specifies where to trim the substrings (start, end, or both).
 */
export function trimStr(str: string, toTrim: string[], where: 'start' | 'end' | 'both' = 'both') {
    if(where !== 'end'){
        for (let i = 0; i < toTrim.length; i++){
            const t = toTrim[i];
            if (t && str.startsWith(t)) {
                str = str.substring(t.length);
                i = -1;
            }
        }
    }
    if(where !== 'start'){
        for (let i = 0; i < toTrim.length; i++){
            const t = toTrim[i];
            if (t && str.endsWith(t)) {
                str = str.substring(0, str.length - t.length);
                i = -1;
            }
        }
    }
    return str;
}

export function runCheckIgnore<T>(fn:() => T, onError: TOnError | undefined){
    try {
        return fn();
    } catch (e) {
        if (!onError || onError === 'throw') {
            throw e;
        } else if (onError === 'print') {
            logError(e);
        }else{
            // logWarning(`\n-> LOCAL: Ignoring error...`);
        }
    }
}
export async function runCheckIgnoreAsync<T>(fn:() => Promise<T>, onError: TOnError | undefined){
    try {
        return await fn();
    } catch (e) {
        if (!onError || onError === 'throw') {
            throw e;
        } else if (onError === 'print') {
            logError(e);
        }else{
            // logWarning(`\n-> LOCAL: Ignoring error...`);
        }
    }
}

['debug', 'warn', 'error'].forEach((methodName) => {
    const originalLoggingMethod = (console as any)[methodName];
    (console as any)[methodName] = (firstArgument: any, ...otherArguments: any[]) => {
        let str = '';
        let func = '';
        if(!calleLocRefToLogFn){
            const ignore = [
                'at getCalleeLocation ', 
                'at log ',
                'at logError',
                'at logSuccess ',
                'at logWarning ',
                'at logInfo ',
                'at Object.onStderr ',
                'console.<computed> ',
            ]
            const originalPrepareStackTrace = Error.prepareStackTrace;
            Error.prepareStackTrace = (_, stack) => stack;
            const trace = new Error().stack as unknown as CallSite[];
            let origin = trace[0];
            let selectedIndex = 0;
            let funcHistory = '';
            for(let i = 0; i < trace.length; i++){
                const t = trace[i];
                // console.log({t: t.getFunctionName(), m: t.getMethodName(), f: t.getFileName(), l: t.getLineNumber()});
                if(!t.getFileName()?.startsWith('file://'))
                    continue;
                let func = t.getFunctionName();
                if(!func || func == 'onCatch' || func?.startsWith('log'))
                    continue;
                if(ignore.some(t => func!.startsWith(t)))
                    continue;
                if(func.includes('<computed>') && t.getMethodName()){
                    func = func.replace('<computed>', t.getMethodName()!);
                }
                // originalLoggingMethod(t.getFileName()+':'+t.getLineNumber() + ':' + func + ':' + t.getMethodName());
                if(!selectedIndex){
                    origin = t;
                    selectedIndex = i;
                    funcHistory = func;
                    continue;
                }
                if(funcHistory){
                    funcHistory = func + ' -> ' + funcHistory;
                }
            }
            // if(selectedIndex )
            // originalLoggingMethod((new Error().stack as unknown as CallSite[]).map(t => t.getFileName()+':'+t.getLineNumber() + ':' + t.getMethodName() + ':' + t.getFunctionName() + ':' + t.getEvalOrigin() ));
            // const callee = new Error().stack?.[1] as unknown as CallSite;
            Error.prepareStackTrace = originalPrepareStackTrace;
            const relativeFileName = fsPath.relative(process.cwd(), origin.getFileName() || '');
            str = `${relativeFileName}:${origin.getLineNumber()}`;
            if(str.includes('/dist/'))
                str = str.split('/dist/')[1];
            func = (funcHistory || origin.getFunctionName())?.replace(' Object.', ' ') || '';
        }else{
            str = calleLocRefToLogFn.toString();
            func = calleLocRefToLogFn.method;
        }
        if(func.startsWith('Object.'))
            func = func.substring(7);
        str = styleText('gray', `(${str}: ${func})`);
        if (typeof firstArgument === 'string') {
            originalLoggingMethod(firstArgument, ...[...otherArguments, str]);
        } else {
            originalLoggingMethod(firstArgument, ...[...otherArguments, str]);
        }
    };
});

export type TCalleeLoc = {
    file: string,
    line: number,
    method: string,
    toString: () => string,
}
export function getCalleeLocation(back = 0, err:Error|undefined = undefined): TCalleeLoc | undefined {
    const ignore = [
        'at getCalleeLocation ', 
        'at onCatch ',
        'at runShell ',
        'at log ',
        'at logError',
        'at logSuccess ',
        'at logWarning ',
        'at logInfo ',
        'at Object.onStderr ',
        'at Object.onStderr ',
        'at console.<computed> ',
    ]
        err ??= new Error();
        if (err.stack) {
            // Parse the stack trace to extract the line number
            const stackLines = err.stack.split("\n");
            const projectLinesWithIgnores = stackLines
                .filter(t => t.includes(' (/') && !t.includes('node_modules') && !t.includes(' (node:'))
                .map(t => t.replace(' Object.', ' ').trim());
            let projectLines = projectLinesWithIgnores.filter(t => !ignore.some(y => t.startsWith(y)));

            if(!projectLines.length)
                projectLines = projectLinesWithIgnores;
            
            // console.log(projectLines);
            // The third line in the stack usually contains the callee information
            // const callerLine = stackLines[2] || stackLines[1];
            const callerLine = projectLines[back + 2] || projectLines[back+1] || projectLines[back] || projectLines[1] || projectLines[0] || undefined;
            
            if(!callerLine){
                return undefined;
            }

            // Extract the line number from the stack trace
            const lineMatch = callerLine.match(/:(\d+):\d+/);
            if (lineMatch) {
                const lineNo = parseInt(lineMatch[1], 10);

                const fileName = callerLine.match(/at (.+):/)?.[1]?.replace(' Object.', ' ') || '<no-file-found>';

                return {
                    file: fileName,
                    line: lineNo,
                    method: callerLine.split(' (')[0].split('at ')[1],
                    toString: () => {
                        let f = fileName;
                        if(f.includes('/dist/'))
                            f = f.split('/dist/')[1];
                        return `${f}:${lineNo}`;
                    }
                };
            }
        }
    return undefined; // Return null if no line number is found
}

let calleLocRefToLogFn: TCalleeLoc | undefined = undefined;
type StyleName = Extract<Parameters<typeof styleText>[0], string>;
export const logColors = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright',
    'magentaBright', 'cyanBright', 'whiteBright', 'gray', 'grey',
] as const satisfies readonly StyleName[];
export type LogColor = typeof logColors[number];

/**
 * Logs a message to the console with the specified color and log method.
 * @param message The message to log.
 * @param color The color to use for the log message.
 * @param logMethod The log method to use (log, warn, error, debug).
 * @param calleLoc The location of the caller (file, line, method).
 */
export function log(message: any, color?: LogColor, logMethod: 'log' | 'warn' | 'error' | 'debug' = 'log', calleLoc: TCalleeLoc | undefined = undefined) {
    calleLocRefToLogFn = calleLoc;
    try {
        if(typeof message === 'object'){
            // console.log('type: ' + typeof message);
            if(Buffer.isBuffer(message)){
                message = message.toString()
            }else{
                message = JSON.stringify(message, null, 2)
                if(message.length == 2)
                    return;
            }
        }
        message =  message?.toString();
    } catch (error) {

    }
    message =  message?.toString();
    message = message.replace('\\r\\n', '\r\n')
                    .replace('\\n', '\n');
    
    
    if (color)
        return console[logMethod](styleText(color, message));

    if (!message.includes('|'))
        return console[logMethod](message);

    const f = message.split('|');
    color = logColors.find(t => t == f[0]);
    return log(message.substring(f[0].length + 1), color);
}

/**
 * Logs an error message to the console.
 * @param message The error message to log.
 * @param exit If true, the process will exit with code 1.
 * @param calleLoc The location of the caller (file, line, method).
 */
export const logError = (message: any, exit?: boolean, calleLoc: TCalleeLoc | undefined = undefined) => {
    log(message?.toString(), 'red', 'error', calleLoc);
    if (exit)
        process.exit(1);
};

/** 
 * Logs a success message to the console.
 * @param message The success message to log.
 * @param calleLoc The location of the caller (file, line, method).
 */
export const logSuccess = (message: any, calleLoc: TCalleeLoc | undefined = undefined) => {
    return log(message?.toString(), 'green', 'log', calleLoc);
};
/**
 * Logs a warning message to the console.
 * @param message The warning message to log.
 * @param calleLoc The location of the caller (file, line, method).
 */
export const logWarning = (message: any, calleLoc: TCalleeLoc | undefined = undefined) => {
    return log(message?.toString(), 'yellow', 'warn', calleLoc);
};

/**
 * Logs an info message to the console.
 * @param message The info message to log.
 * @param calleLoc The location of the caller (file, line, method).
 */
export const logInfo = (message: any, calleLoc: TCalleeLoc | undefined = undefined) => {
    return log(message?.toString(), 'blue', 'log', calleLoc);
};

/**
 * Sleeps for a given amount of time.
 * @param ms milliseconds to sleep
 */
export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Converts a Unix timestamp to a human-readable date string.
 * @param timestamp in seconds
 * @returns A string representing the date in the format "YYYY-MM-DD HH:mm:ss"
 */
export function unixTsToDate(timestamp: number) {
    const s = new Date(timestamp * 1000).toISOString();
    return s.substring(0, s.indexOf('.')).replace('T', ' ');
}

/**
 * Redrawing the bar in place needs cursor control, which a TTY has and a pipe or a log file does not:
 * `process.stdout.clearLine`/`cursorTo` are missing there, and calling them throws away the whole run.
 * Deploys are often started with their output captured (CI, another tool, `bun run deploy > log`), so the
 * bar is skipped when it cannot be redrawn.
 */
const canRedrawProgress = () => {
    const stream = process.stdout as Partial<NodeJS.WriteStream>;

    return Boolean(stream.isTTY && typeof stream.clearLine === 'function' && typeof stream.cursorTo === 'function');
};

/**
 * CLI style progress bar
 */
export const progressBar = {
    /**
     * Displays or updates the progress bar in the console.
     * @param currentProgress The current progress percentage (0-100).
     * @param text Additional text to display alongside the progress bar.
     */
    play: (currentProgress: number, text: string) => {
        if (!canRedrawProgress()) return;

        const barWidth = 30;
        const filledWidth = Math.floor(currentProgress / 100 * barWidth);
        const emptyWidth = barWidth - filledWidth;
        const progressBar = '█'.repeat(filledWidth) + '▒'.repeat(emptyWidth);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`[${progressBar}] ${currentProgress}% ${text}`);
    },
    /**
     * Clears the progress bar from the console.
     */
    clear: () => {
        if (!canRedrawProgress()) return;

        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
    }
}

/**
 * Converts a number of bytes to a human-readable string.
 * @param bytes number of bytes
 * @returns A string representing the size in a human-readable format.
 */
export function bytesToSizeStr(bytes: number): string {
    if(bytes < (1024 * 1024)) return (bytes / 1024).toFixed(2) + " kb";

    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}