import { execSync } from "child_process";
import { NodeSSH } from "node-ssh";
import fs from 'node:fs';
import { EOL } from "node:os";
import { styleText } from "node:util";
import prompts from "prompts";
import { TOnError } from "../types.ts";
import { getCalleeLocation, log, logError, logInfo, logWarning } from "./helpers.ts";

type TLog = typeof log;
export type ShellProps = {
    /** If true, the command will be executed on the remote server via SSH. */
    ssh?: boolean,
    /** The command to execute */
    command: string,
    /** A message to log before executing the command. Can be a string, a function, or an array with log parameters. */
    message?: string |
         ((props: ShellProps, log: TLog) => void) |
         [Parameters<TLog>[1], string],
    /** What to do on error. */
    on_error?: TOnError,
    /** If true, the command's output will be ignored. */
    ignore_stdout?: boolean,
    /** A callback function to handle errors. */
    onError?: (err: any) => void,
}

export type ShellPropsExtended = Omit<ShellProps, 'command'> & {
    /** The command to execute. Can be a string, an array of strings (joined with &&), or an object with separate commands for Windows and Unix. */
    command: string | string[] | { windows: string, unix: string },
}

/** Run a command on a remote server via SSH. */
export async function runSshShell(props: ShellProps, ssh: NodeSSH): Promise<string> {
    return runShell(props, ssh);
}

/** Run a command on the local machine. */
export async function runLocalShell(props: ShellProps): Promise<string> {
    return runShell(props);
}

/**
 * Run a command on a remote server or the local machine.
 * @param props The shell properties. if ignore_stdout is false, it will return the output of the command. (only for local shell)
 * @param ssh The SSH connection (if running on a remote server).
 */
export async function runShell(props: ShellProps, ssh?: NodeSSH): Promise<string> {
    const calleLoc = getCalleeLocation();
    const {command: cmd, message, on_error, ignore_stdout} = props;
    if(message){
        if(typeof message === 'string')
            log(message);
        else if(Array.isArray(message))
            log(message[1], message[0]);
        else
            message(props, log);
    }
    
    // console.log(cmd);

    if (process.argv.includes('--act')) {
        log(`->ACT shell: ${cmd}`, 'cyan')
        return ''; // TODO: return undefined?
    }

    const onCatch = (err: any) => {
        // logError(err.toString());
        const errStr = err?.stderr?.toString().replace('bash: line 0: ', '').trim();

        if (props.onError)
            props.onError(errStr ?? err);

        if (on_error === 'ignore' || on_error === 'print'){
            if(on_error === 'print'){
                // calleErrHistory.push(err)
                logWarning(errStr ?? err, calleLoc);
            }
            return ''; // TODO: return undefined?
        }

        if (err.status && !ignore_stdout) {
            logError("runShell failed with status " + err.status, undefined, calleLoc)
        }

        if (ssh) {
            ssh.dispose();
        }


        if (!message)
            logInfo(`shell command failed: ${cmd}`, calleLoc);

        if (errStr) {
            logError(errStr, undefined, calleLoc);
            process.exit(1);
        }

        logWarning(`THROWING ERROR!`, calleLoc);
        throw err; // TODO: prevent this from happening. try to print the error message
    }

    try {
        if (ssh) {
            // console.log('calleLoc: ' + getCalleeLocation(0))
            const res = await ssh.exec(cmd, [], {
                onStderr: c => {
                    onCatch({
                        stderr: c.toString()
                    });
                    return ''; // TODO: return undefined?
                }
            })
            return res?.toString().trim();
        } else {
            const res = execSync(cmd, {stdio: ignore_stdout ? 'pipe' : 'inherit'});
            if (ignore_stdout)
                return res?.toString().trim();
        }

        return '';
    } catch (err) {
        // console.log("calleLOC: " +getCalleeLocation(0, err as any))
        return onCatch(err);
    }
}

/**
 * Parse environment variables from a .env file.
 * @param filePath The path to the .env file. Default is './.env'.
 * @param exitIfNoEnv Whether to call 'process.exit(1)' if the provided file path does not exist. Default is true.
 * @returns An object containing the parsed environment variables.
 */
export function parseEnv(filePath = './.env', exitIfNoEnv = true) {
    if (!fs.existsSync(filePath)) {
        console.log(styleText('red', 'No .env file found!'));
        return exitIfNoEnv ? process.exit(1) : {};
    }
    return parseYaml(fs.readFileSync(filePath).toString());
}

/**
 * Parse the content of a YAML file.
 */
export function parseYaml(content: string): Record<string, string> {
    let lines = content.split(EOL)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !t.startsWith('#'))
        .filter(t => t.includes('='));

    return lines.reduce((obj: any, t) => {
        let val = t.substring(t.indexOf('=') + 1);

        if(val.startsWith('"') && val.endsWith('"'))
            val = val.substring(1, val.length - 1);
        else if(val.startsWith("'") && val.endsWith("'"))
            val = val.substring(1, val.length - 1);

        obj[t.split('=')[0]] = val;

        return obj;
    }, {});
}

/**
 * Quote a string for use in a shell command. The function chooses single or double quotes based on the content of the string.
 */
export function quotify(str: string) {
    const single = str.includes("'");
    const double = str.includes('"');

    let quote = '"';
    if(double){
        str = single ? str.replace(/"/g, '\\"') : str;
        quote = single ? '"' : "'";
    }

    return quote + str + quote;
}

/**
 * Prompt the user for input.
 * @param cfg Configuration object.
 * @param cfg.message The message to display in the prompt.
 * @param cfg.initial The initial value (default: true).
 * @returns A promise that resolves to the user's response.
 */
export async function promptConfirm(cfg: { message: string, initial?: boolean }) {
    return (await prompts({
        type: 'confirm',
        name: 'value',
        message: cfg.message,
        initial: cfg.initial ?? true,
    })).value;
}

/** 
 * Prompt the user to choose from a list of options.
 * @param cfg Configuration object.
 * @param cfg.message The message to display in the prompt.
 * @param cfg.choices The list of choices.
 * @returns A promise that resolves to the user's selected choice.
 */
export async function promptChoice(cfg: { message: string, choices: prompts.Choice[] }) {
    return (await prompts({
        type: 'select',
        name: 'value',
        message: cfg.message,
        choices: cfg.choices
    })).value;
}