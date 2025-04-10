import fs from "node:fs";
import { EOL, type } from "node:os";
import YAML from "yaml";
import packageJson from "../package.json" with { type: "json" };
import { OS } from "../src/types.ts";
import { parseEnv, promptChoice, promptConfirm, ShellProps } from "../src/utils/cli_utils.ts";
import { getCalleeLocation, logError, logWarning, normalizePath, stringFormat, TCalleeLoc } from "../src/utils/helpers.ts";
import defaultConfigIIS from "./barke.iis.yml";
import defaultConfigLaravel from "./barke.laravel.yml";
import { obsoletePredefinedMethods, predefinedMethodNames, TPredefined, TYamlConfig, TYamlConfigRaw, TYamlRule, TYamlShell, yamlConfigValidationRules } from "./yaml_types.ts";

export let defaultBarkeYamlPath = "./barke.yml";
export async function parseBarkeYaml(){
    if (process.argv.includes('--version')) {
        console.log(packageJson.version);
        process.exit(0);
    }
    if (process.argv.includes('--help')) {
        console.log(`
options:
    --version           : flag to print the version
    --config            : path to *.barke.yml file
    --methods           : flag to print all available predefined methods
    --print-config      : flag to print the parsed yaml file. (useful for debugging)
    --fresh             : flag to skip comparing local files with remote files. (=upload all files. this takes more time)
    --act               : flag to print the shell commands without executing them
    --dry-run           : flag to run until predefined function "local:exit_if_dry_run" is called. You can change its position in your barke.yml file
    --help              : flag to print this message
`);
        process.exit(0);
    }
    if (process.argv.includes('--methods')) {
        console.log(predefinedMethodNames.toSorted((a,b) => a.localeCompare(b)).join(EOL));
        process.exit(0);
    }
    // console.log(getCalleeLocation());
    // process.exit(1);
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i].startsWith('--config')) {
            defaultBarkeYamlPath = process.argv[i].split('=')[1];
            if (!fs.existsSync(defaultBarkeYamlPath)) {
                logError(`Config file "${defaultBarkeYamlPath}" does not exist!`);
                process.exit(1);
            }
            break;
        }
    }

    await checkBarkeYamlFile();

    // const str = fs.readFileSync(ftpDeployYamlPath, 'utf8');
    let configStr = fs.readFileSync(defaultBarkeYamlPath, 'utf8')
        .split(EOL)
        .filter(t => t.trim().length > 0 && !t.trim().startsWith('#'))
        .join(EOL);

    // search for env variables in the yaml file
    const envKeys = configStr.match(/\${env\.[a-zA-Z0-9_.]+}/g);
    if (envKeys) {
        for (const key of envKeys) {
            const val = getValueOfStringArgFromYaml({config: {}, steps: []}, key);
            if (val === undefined) {
                logError(`"${key}" is not found in .env file!`);
                process.exit(1);
            }
            configStr = configStr.replace(key, val);
        }
    }

    const yamlRaw = YAML.parse(configStr) as TYamlConfigRaw;

    const printConfig = process.argv.includes('--print-config') || process.argv.includes('--trace');
    try {
        const yaml = validateYamlReplaceVarsConfig(yamlRaw);

        yaml.config.local_basepath = normalizePath(yaml.config.local_basepath);
        yaml.config.ignores = formatIgnores(yaml);

        if (printConfig) {
            console.log(JSON.stringify(yaml, null, 2));
            process.exit(0);
        }
        return yaml;
    }catch (e){
        if(printConfig){
            console.log(JSON.stringify(yamlRaw, null, 2));
        }
        throw e;
    }
}

function uniqueId() {
    return Math.random().toString(36).substring(2, 9);
}

function validateYamlReplaceVarsConfig(yaml: TYamlConfigRaw) : TYamlConfig {
    if(!yaml.config || !yaml.steps){
        logError('config or steps is not set in your yaml file!');
        process.exit(1);
    }
    
    type ValidationLevelLine = { level: number, line: TCalleeLoc };
    type ValidationResultSingle = ValidationLevelLine & { exit?: boolean, error: string };
    type ValidationResultMultiple = ValidationLevelLine & {errors: ValidationResultSingle[]};
    type ValidationResult = ValidationResultSingle | ValidationResultMultiple | 'success';

    function addValResToArr(arr: ValidationResultSingle[], toAdd: ValidationResultSingle | ValidationResultMultiple) : ValidationResultSingle[] {
        if('error' in toAdd){
            // if(!errs.some(t => t.level == res.level && t.error == res.error))
                arr.push(toAdd);
            return arr;
        }

        return arr.concat(toAdd.errors);
    }

    const checkSimpleRule = (obj: Record<string, any>, prop:string, rule: TYamlRule, keyPre:string, level: number, parentId: string) : ValidationResult => {
        const id = `${parentId}-${uniqueId()}`;
        function makeErr(msg: string){
            return {level, error: `${keyPre}${prop}-> ${msg}`, line: getCalleeLocation(1), id};
        }
        if(!(prop in obj)){
            return rule.required === true ? makeErr(`is required!`) : 'success';
        }
        // console.log(rule, prop, obj[prop])
        switch(rule.type){
            case 'string': {
                return typeof obj[prop] !== 'string' ? makeErr(`must be a string!`) : 'success';
            }
            case 'array': {
                return !Array.isArray(obj[prop] ?? []) ? makeErr(`must be an array!`) : 'success';
            }
            case 'boolean': {
                return [0,1,true,false].some(t => t.toString() == obj[prop].toString()) ? 'success' : makeErr(`must be a boolean!`);
            }
            case "number":
                return obj[prop]?.toString().match(/^\d+$/) ? 'success' : makeErr(`must be a number!`);
            case "const":
                return obj[prop] === rule.value ? 'success' : makeErr(`must be exactly: ${rule.value}!`);
            case "oneOfValues":
                return rule.options.includes(obj[prop]) ? 'success' : makeErr(`must be one of these: ${rule.options.join(', ')}, but it was: ${JSON.stringify(obj[prop])}!`);
            default: {
                logError('DEBUG: this rule is not a simple rule: '+(rule as any).type);
                process.exit(1);
            }
        }
    }

    const allPredefinedRules = yamlConfigValidationRules.step.predefined.rules
    const checkPredefinedRule = (obj: Record<string, TPredefined>, prop:string, rule: TYamlRule, keyPre:string, level: number, parentId: string): ValidationResult => {
        const val = obj[prop];
        const id = `${parentId}-${uniqueId()}`;
        function makeErr(msg: string){
            return {level, error: `${keyPre}${prop}-> ${msg}`, line: getCalleeLocation(1), id};
        }
        if(typeof val === 'string'){
            return predefinedMethodNames.includes(val)
                ? 'success' 
                : makeErr(`must be one of these predefined methods: ${predefinedMethodNames.join(', ')}!`);
        }
        if(typeof val !== 'object'){
            return makeErr(`DEBUG: must be a string or an object!`);
        }

        const methodName = val.method;
        if (methodName in obsoletePredefinedMethods) {
            return makeErr(`Obsolete method "${methodName}": ${obsoletePredefinedMethods[methodName]}`);
        }

        if (!predefinedMethodNames.includes(methodName)) {
            return makeErr(`"${methodName}" is not a valid predefined function`);
        }

        // if(allPredefinedRules.some(t => t.type == 'const' && t.value == methodName)){
        //     return 'success';
        // }
        if (!allPredefinedRules.some(t => t.type == 'object' && t.props.method.value == methodName)) {
            return makeErr(`"${methodName}" is not a valid predefined function`);
        }


        let errs: ValidationResultSingle[] = [];
        for(const r of allPredefinedRules){
            if(r.type == 'const' || !(r.type == 'object' && r.props.method.value == methodName))
                continue;

            let errs2: ValidationResultSingle[] = [];
            for(const key in r.props){
                const p = r.props[key];
                if(p.required === false && !(key in val)){
                    continue;
                }
                
                const res = configCheck(val, key, p, `${keyPre}${prop}.`, level+1, id)
                if(res !== 'success'){
                    errs2 = addValResToArr(errs2, res);
                }
            }
            // if(errs2.length === 0){
            //     errs = [];
            //     break;
            // }else{
                errs = [...errs, ...errs2];
            // }
        }
        if(errs.length === 0)
            return 'success';
        
        return makeErr(errs.map(t => t.error).join(EOL));
    }

    const checkObjectRule = (obj: Record<string, any>, prop:string, rule: TYamlRule, keyPre:string, level: number, parentId: string) : ValidationResult => {
        if(rule.type !== 'object'){
            logError('DEBUG: this rule is not an object rule: '+(rule as any).type);
            process.exit(1);
        }
        const id = `${parentId}-${uniqueId()}`;
        function makeErr(msg: string){
            return {level, error: `${keyPre}${prop}-> ${msg}`, line: getCalleeLocation(1), id};
        }
        if(typeof obj[prop] !== 'object'){
            return makeErr(`must be an object!`);
        }
        if(!rule.acceptsOtherProps){
            for(const key in obj[prop]){
                if(!(key in rule.props)){
                    return makeErr(`.${key} is not known!`);
                }
            }
        }
        let errs: ValidationResultSingle[] = [];
        for(const key in rule.props){
            if(!(key in obj[prop])){
                if(rule.props[key].required === false)
                    continue;
                return makeErr(`.${key} is not set!`);
            }
            const res = configCheck(obj[prop], key, rule.props[key], `${keyPre}${prop}.`, level+1, id)
            if(res !== 'success'){
                errs = addValResToArr(errs, res);
            }
        }
        if(errs.length === 0)
            return 'success';
        return {level, errors: errs, line: getCalleeLocation(0)};
    }

    const checkOneOfRulesRule = (obj: Record<string, any>, prop:string, rule: TYamlRule, keyPre:string, level: number, parentId: string) : ValidationResult => {
        if(rule.type !== 'oneOfRules'){
            logError('DEBUG: this rule is not a oneOfRules rule: '+(rule as any).type);
            process.exit(1);
        }

        const id = `${parentId}-${uniqueId()}`;
        function makeErr(msg: string){
            return {level, error: `${keyPre}${prop}-> ${msg}`, line: getCalleeLocation(1), id};
        }

        // console.log(`${level}. checking ${keyPre}${prop}`, obj, rule)
        let errors: ValidationResultSingle[]|'success' = [];
        // console.log(rule.rules)
        for(const subRule of rule.rules){
            if(subRule.type == 'object' && !obj[prop]){
                continue;
            }
            let res = configCheck(obj, prop, {
                ...subRule,
                required: false,
            }, keyPre, level+1, id);
            if(res === 'success'){
                errors = 'success';
                break;
            }else{
                errors = addValResToArr(errors, res);

                // if(res.level > level+1){
                //     if(errors.length > 1)
                //         errors = [errors[errors.length-1]]
                //     break;
                // }
            }
        }
        if(errors === 'success')
            return 'success';
        if(errors.length === 0)
            // return {level, error: `'${keyPre}${prop}' failed validation: ${JSON.stringify(obj[prop])}!`};
            return makeErr(`failed validation: ${JSON.stringify(obj[prop])}!`);

        // console.log(errors)
        if(level == 0){
            // return {level, error: errors.map(t => t.error).join(EOL)};
            return {level, errors, line: getCalleeLocation(0)};
            // return errors;
            // return makeErr(errors[errors.length-1].error);
        }
        return {level, errors, line: getCalleeLocation(0)};
    }

    const configCheck = (obj: Record<string, any>, prop:string, rule: TYamlRule, keyPre:string, level: number, parentId: string) : ValidationResult => {
        if(rule.type === 'object'){
            return checkObjectRule(obj, prop, rule, keyPre, level, parentId);
        }else if(rule.type !== 'oneOfRules'){
            return checkSimpleRule(obj, prop, rule, keyPre, level, parentId);
        }else if(rule.type === 'oneOfRules'){
            return checkOneOfRulesRule(obj, prop, rule, keyPre, level, parentId);
        }else{
            logError('DEBUG: unknown rule: '+(rule as any).type);
            process.exit(1);
        }
    }

    const res = configCheck(yaml, 'config', yamlConfigValidationRules.config, '', 0, 'top');
    if(res !== 'success'){
        console.log(yaml.config)
        console.log(res);
        process.exit(1);
    }

    const stepRule = yamlConfigValidationRules.step;
    // console.log(stepRule)
    const rule = () => ({
        type: 'oneOfRules',
        rules: Object.keys(stepRule).map(k => {
            return {
                type: 'object',
                props: {
                    [k]: {
                        ...stepRule[k],
                    },
                },
                // required: false,
            } satisfies TYamlRule;
        })
    } satisfies TYamlRule);
    for(const step of yaml.steps){
        const r = 
            'predefined' in step 
            ? checkPredefinedRule(step, 'predefined', rule(), '', 0, 'toppredefined')
            : configCheck({step: step}, 'step', rule(), '', 0, 'topstep');
        if(r !== 'success'){
            // console.log('-------------------------------------------------')
            // console.log(JSON.stringify({
            //     obj: {step: step}, 
            //     prop: 'step', 
            //     rule: rule(), 
            //     bla: ''
            // }, null, 2))
            if('predefined' in step){
                let methodName = typeof step.predefined === 'object' ? step.predefined.method : step.predefined;
                if (methodName in obsoletePredefinedMethods) {
                    logError(`Obsolete method "${methodName}": ${obsoletePredefinedMethods[methodName]}`);
                    process.exit(1);
                }
                if (!(predefinedMethodNames as any).includes(methodName)) {
                    logError(`"${methodName}" is not a valid predefined function`);
                    process.exit(1);
                }
            }

            if('error' in r && (r.error.startsWith('step must be one of these rules: ') || r.error.startsWith("'step' failed validation:"))){
                console.log('only these step types are available: '+ Object.keys(stepRule).map(t=>`'${t}'`).join(', ')+'. '+EOL+'Failed step: ');
            }else{
                // const strStep = JSON.stringify(step);
                // console.log('awafawf')
                // console.log(('error' in r ? r.error : r.errors.join(EOL)).replace(strStep+'!', ''));
                console.log(('error' in r ? r.error : r.errors[r.errors.length-1].error));
                console.log(r);
            }
            console.log(step)
            process.exit(1);
        }
    }

    for(const step of yaml.steps){
        if('shell' in step){
            const shell = formatShellStep(yaml as any, step.shell);
            if('args' in shell)
                shell.args = undefined;
        }else if('predefined' in step && typeof step.predefined === 'object'){
            for (const k in step.predefined) {
                if (k === 'method')
                    continue;
                const res = getValueOfStringArgFromYaml(yaml, step.predefined[k]);
                if (res === undefined) {
                    logError(`"${step.predefined.method}.${k}" has "${step.predefined[k]}" as argument but it doesn't exist in yaml!`);
                    process.exit(1);
                }
                step.predefined[k] = res;
            }
        }
    }
    return yaml as TYamlConfig
}

async function checkBarkeYamlFile() {
    if (fs.existsSync(defaultBarkeYamlPath))
        return;

    const shouldCreateNew = await promptConfirm({
        message: 'No ".barke.yml" file found in the root directory. Do you want to create a new one? (default: Yes)',
    });
    if (!shouldCreateNew)
        process.exit(1);

    const os = await promptChoice({
        message: 'What is the remote OS?',
        choices: [
            {title: 'Windows', value: 'windows'},
            {title: 'Unix (Linux, MacOS etc.)', value: 'unix'},
        ]
    }) as OS;

    fs.writeFileSync(defaultBarkeYamlPath, os === 'windows' ? defaultConfigIIS : defaultConfigLaravel);

    const contentToAddToEnv = 'HOST_SERVER=\nFTP_USERNAME=\nFTP_PASSWORD=\nSSH_USERNAME=\nSSH_PASSWORD=\n';
    if (!fs.existsSync('.env')) {
        fs.writeFileSync('.env', contentToAddToEnv);
        logWarning('\n- Created default ".env" file in the root directory. Fill in all information.');
    } else {
        const content = fs.readFileSync('.env').toString();
        if (!content.includes('FTP_') && !content.includes('SSH_')) {
            fs.appendFileSync('.env', contentToAddToEnv);
            logWarning('\n- Added default "FTP_" and "SSH_" variables to the existing ".env" file. Fill in all information.');
        }
    }
    logWarning('- Created default "barke.yml" file in the root directory. Have a look, edit if necessary and start again!');

    if (fs.existsSync('.gitignore')) {
        const content = fs.readFileSync('.gitignore').toString();
        if (!content.includes('.env') && await promptConfirm({
            message: 'Your .gitignore does NOT contain ".env". Do you want to add it? (Highly recommended) (default: Yes)',
        })) {
            fs.appendFileSync('.gitignore', '\n.env')
            logWarning('- Added ".env" to .gitignore');
        }
    } else {
        const shouldCreateNew = await promptConfirm({
            message: 'No ".gitignore" file found in the root directory. Do you want to create a default one? (default: Yes)',
        });
        if (shouldCreateNew) {
            fs.writeFileSync('.gitignore', '.env\nnode_modules');
            logWarning('- Created default ".gitignore" file in the root directory. Added ".env" to it');
        }
    }

    process.exit(1);
}


let env: Record<string, any>;
export function getValueOfStringArgFromYaml(config: TYamlConfig|Record<string, any>, strKey: string) {
    if(typeof strKey !== 'string')
        return strKey;
    strKey = strKey?.trim();
    if (typeof strKey !== 'string' || !strKey.startsWith('${') || !strKey.endsWith('}')) {
        // console.log('returning key -'+ strKey+"-")
        return strKey;
    } else {
        let dottedKey = strKey.substring(2, strKey.length - 1);
        let obj: Record<string, any>;
        if(dottedKey.startsWith('env.')){
            obj = env ??= parseEnv()!;
            dottedKey = dottedKey.substring(4);
        }else
            obj = config;

        const [k, ...keys] = dottedKey.split('.');
        let val = obj[k];
        for (const k of keys) {
            if (!val) {
                return undefined;
            }
            val = val[k];
        }
        if (val !== undefined)
            return val as string;

        return undefined;
    }
}

function formatShellStep(config: TYamlConfig, shell: TYamlShell) : ShellProps {
    let cmd = shell.command as string|{windows: string, unix: string};
    if(typeof cmd === 'object') {
        if(shell.ssh){
            cmd = config.config.target_os === 'windows' ? cmd.windows : cmd.unix;
        }else{
            cmd = process.platform === 'win32' ? cmd.windows : cmd.unix;
        }
    }

    if ('args' in shell && Array.isArray(shell.args) && shell.args.filter(t => t).length){
        const args: string[] = [];
        for (let a of shell.args.filter(t=>t)) {
            const res = getValueOfStringArgFromYaml(config, a);
            if (res === undefined) {
                logError(`"${cmd}" has "${a}" as argument but it doesn't exist in config!`);
                process.exit(1);
            }
            args.push(res);
        }
        cmd = stringFormat(cmd as string, args);
    }
    return {
        command: cmd,
        on_error: shell.on_error,
        ignore_stdout: shell.ignore_stdout,
        message: shell.message?.includes('${command}') ? shell.message.replace(/\${command}/g, cmd) : shell.message,
        ssh: shell.ssh
    };
}

export function formatIgnores(yaml: TYamlConfig) {
    const ignores = yaml.config.ignores;
    if (!ignores)
        return ignores;

    return ignores.map(t => {
        if(t.includes('\*'))
            t = t.replace('\\*', '*');
        return t;
    });

}

