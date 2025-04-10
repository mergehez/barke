import chalk from "chalk";
import { execSync } from "child_process";
import { NodeSSH } from "node-ssh";
import fs from 'node:fs';
import { EOL } from "node:os";
import prompts from "prompts";
import { TOnError } from "../types.ts";
import { getCalleeLocation, log, logError, logInfo, logWarning } from "./helpers.ts";

type TLog = typeof log;
export type ShellProps = {
    ssh?: boolean,
    command: string,
    message?: string |
         ((props: ShellProps, log: TLog) => void) |
         [Parameters<TLog>[1], string],
    on_error?: TOnError, // print: print but don't throw. (default: throw)
    ignore_stdout?: boolean,
    return_error?: boolean,
    onError?: (err: any) => void,
}

export type ShellPropsExtended = Omit<ShellProps, 'command'> & {
    command: string | string[] | { windows: string, unix: string },
}


export async function runSshShell(props: ShellProps, ssh: NodeSSH): Promise<string> {
    return runShell(props, ssh);
}

export async function runLocalShell(props: ShellProps): Promise<string> {
    return runShell(props);
}

// if ignore_stdout is false, it will return the output of the command. (only for local shell)
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

export function parseEnv(prefix: string = '', exitIfNoEnv = true, removePrefix = false) {
    if (!fs.existsSync('./.env')) {
        console.log(chalk.red('No .env file found!'));
        return exitIfNoEnv ? process.exit(1) : {};
    }
    return parseYaml(fs.readFileSync('./.env').toString(), prefix, removePrefix);
}

export function parseYaml(content: string, prefix: string = '', removePrefix = false): Record<string, string> {
    let lines = content.split(EOL)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !t.startsWith('#'))
        .filter(t => t.includes('='));

    if (prefix)
        lines = lines.filter(t => t.startsWith(prefix));

    if (prefix && removePrefix)
        lines = lines.map(t => t.substring(prefix.length))

    return lines.reduce((obj: any, t) => {
        obj[t.split('=')[0]] = t.substring(t.indexOf('=') + 1)
        return obj;
    }, {});
}

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

export async function promptConfirm(cfg: { message: string, initial?: boolean }) {
    return (await prompts({
        type: 'confirm',
        name: 'value',
        message: cfg.message,
        initial: cfg.initial ?? true,
    })).value;
}

export async function promptChoice(cfg: { message: string, choices: prompts.Choice[] }) {
    return (await prompts({
        type: 'select',
        name: 'value',
        message: cfg.message,
        choices: cfg.choices
    })).value;
}