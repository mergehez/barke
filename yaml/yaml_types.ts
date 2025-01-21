import { ShellProps } from "../src/utils/cli_utils.ts";

export const obsoletePredefinedMethods: Record<string, string> = {
    'server:upload_files': 'please use "server:upload_files_ssh" or "server:upload_files_ftp" instead',
} as const;

const predefinedParamlessMethods = [
    'local:exit_if_dry_run',
    'server:upload_files_ssh',
    'server:upload_files_ftp',
    'server:find_new_files',
    'local:laravel_clear_cache',
    'server:laravel_optimize',
    'server:unzip',
    'server:delete_zip',
    'local:dispose_ssh',
    'local:dispose_ftp',
    'local:finish',
] as const;
export const predefinedMethodNames = [
    ...predefinedParamlessMethods,
    'server:laravel_composer_update',
    'server:laravel_ensure_dirs_exist',
    'server:laravel_optimize',
    'local:sleep',
    'local:laravel_build',
    'server:restart_iis_site',
    'server:start_iis_site',
    'server:stop_iis_site',
    'server:delete_file',
    'server:delete_files',
    'server:delete_dir',
    'local:delete_file',
    'local:delete_files',
    'local:delete_dir',
] as const;


const shellPropsWithoutCommand = {
    message: { type: 'string', required: false },
    ssh: { type: 'boolean', required: false },
    on_error: { type: 'oneOfValues', options: ['throw', 'print', 'ignore'] as const, required: false },
    ignore_stdout: { type: 'boolean', required: false },
    args: { type: 'array', required: false },
} as const;


export type TYamlRule =
    ({ type: 'string' | 'boolean' | 'number' | 'array' }
        | { type: 'const', value: any }
        | { type: 'oneOfValues', options: readonly any[] }
        | { type: 'oneOfRules', rules: readonly TYamlRule[] }
        | { type: 'object', props: Record<string, TYamlRule>, acceptsOtherProps?: boolean }) & { required?: boolean };
export const yamlConfigValidationRules = {
    config: {
        type: 'object',
        acceptsOtherProps: true,
        props: {
            // @ts-ignore
            target_os: { type: 'oneOfValues', options: ['windows', 'unix'] as const },
            host: { type: 'string' },
            local_basepath: { type: 'string' },
            remote_basepath: { type: 'string' },
            ftp: {
                type: 'object',
                required: false,
                props: {
                    username: { type: 'string' },
                    password: { type: 'string' },
                    base_path: { type: 'string' },
                    secure: { type: 'boolean', required: false },
                }
            },
            ssh: {
                type: 'object',
                required: false,
                props: {
                    port: { type: 'number', required: false },
                    username: { type: 'string' },
                    password: { type: 'string', required: false },
                    private_key_path: { type: 'string', required: false },
                }
            },
            dist_dirs: { type: 'array' },
            ignores: { type: 'array' },
        }
    } satisfies TYamlRule,
    step: {
        log: {
            type: 'oneOfRules',
            rules: [
                { type: 'string' },
                { type: 'object', props: { message: { type: 'string' } } }
            ] as const,
        } satisfies TYamlRule,
        shell: {
            type: 'object',
            props: {
                command: {
                    type: 'oneOfRules',
                    rules: [
                        { type: 'string' },
                        {
                            type: 'object',
                            props: {
                                windows: { type: 'string' },
                                other: { type: 'string' },
                            }
                        }
                    ] as const,
                },
                ...shellPropsWithoutCommand
            }
        } satisfies TYamlRule,
        predefined: {
            type: 'oneOfRules',
            rules: [
                ...predefinedParamlessMethods.map(t => ({ type: 'object', props: { method: { type: 'const', value: t } } } as const)),
                ...predefinedParamlessMethods.map(t => ({ type: 'const', value: t } as const)),
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'local:sleep' },
                        ms: { type: 'number' },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'local:delete_file' },
                        path: { type: 'string' },
                        from_base_path: { type: 'boolean', required: false },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'local:delete_files' },
                        paths: { type: 'array' },
                        from_base_path: { type: 'boolean', required: false },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'local:delete_dir' },
                        path: { type: 'string' },
                        from_base_path: { type: 'boolean', required: false },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:delete_file' },
                        path: { type: 'string' },
                        from_base_path: { type: 'boolean', required: false },
                        ...shellPropsWithoutCommand
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:delete_files' },
                        paths: { type: 'array' },
                        from_base_path: { type: 'boolean', required: false },
                        ...shellPropsWithoutCommand
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:delete_dir' },
                        path: { type: 'string' },
                        from_base_path: { type: 'boolean', required: false },
                        ...shellPropsWithoutCommand
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:restart_iis_site' },
                        pool: { type: 'string' },
                        site: { type: 'string' },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:start_iis_site' },
                        pool: { type: 'string' },
                        site: { type: 'string' },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:stop_iis_site' },
                        pool: { type: 'string' },
                        site: { type: 'string' },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:laravel_composer_update' },
                        force: { type: 'boolean', required: false },
                        on_error: { type: 'oneOfValues', options: ['throw', 'print', 'ignore'] as const, required: false },
                        ignore_stdout: { type: 'boolean', required: false },
                    }
                },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:laravel_optimize' },
                        on_error: { type: 'oneOfValues', options: ['throw', 'print', 'ignore'] as const, required: false },
                        ignore_stdout: { type: 'boolean', required: false },
                    }
                },
                { type: 'const', value: 'server:laravel_composer_update' },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'local:laravel_build' },
                        pm: { type: 'string', required: false },
                        out: { type: 'string', required: false },
                    }
                },
                { type: 'const', value: 'local:laravel_build' },
                {
                    type: 'object',
                    props: {
                        method: { type: 'const', value: 'server:laravel_ensure_dirs_exist' },
                        dirs: { type: 'array' },
                        owner: { type: 'string', required: false },
                        group: { type: 'string', required: false },
                        permissions: { type: 'string', required: false },
                    }
                },
            ] as const
        } satisfies TYamlRule,
    },
} as const;

type ParseRule<R> =
    R extends { type: 'const', value: string }
    ? R['value']
    : R extends { type: infer KT, [K: string]: any }
    ? KT extends 'string' ? string
    : KT extends 'number' ? number
    : KT extends 'boolean' ? boolean
    : KT extends 'array' ? any[]
    : R extends TYamlRule ? ParseAdvancedRule<R>
    : never
    : never;
type OptionalKeys<T> = {
    [K in keyof T]: T[K] extends { required: false } ? K : never;
}[keyof T];

type RequiredKeys<T> = {
    [K in keyof T]: T[K] extends { required: false } ? never : K;
}[keyof T];
type ParseAdvancedRule<R extends TYamlRule> =
    R extends { type: 'object', props: infer Props }
    ? keyof Props extends RequiredKeys<Props>
    ? { [K in RequiredKeys<Props>]: ParseRule<Props[K]> }
    : keyof Props extends OptionalKeys<Props>
    ? { [K in OptionalKeys<Props>]?: ParseRule<Props[K]> }
    : { [K in RequiredKeys<Props>]: ParseRule<Props[K]> } & { [K in OptionalKeys<Props>]?: ParseRule<Props[K]> }
    : R extends { type: 'oneOfRules', rules: Readonly<Array<infer Props>> }
    ? Props extends TYamlRule ? ParseRule<Props> : never
    : R extends { type: 'oneOfValues', options: Readonly<Array<infer Props>> }
    ? Props
    : never;

type IsNotNever<T extends string | boolean | object> = [T] extends [never] ? never : T;



export type TYamlShell = IsNotNever<ParseAdvancedRule<typeof yamlConfigValidationRules.step.shell>>;
export type TPredefined = IsNotNever<ParseAdvancedRule<typeof yamlConfigValidationRules.step.predefined>>;

type TPredWithProps<M, T> = T extends { method: infer Method } ? (Method extends M ? T : never) : never;
export type TPredefinedWithProps<M extends typeof predefinedMethodNames[number]> = Exclude<TPredefined extends infer T ? TPredWithProps<M, T> : never, never>;
type TConfig = IsNotNever<ParseAdvancedRule<typeof yamlConfigValidationRules.config>>;
type TLog = IsNotNever<ParseAdvancedRule<typeof yamlConfigValidationRules.step.log>>;
export type TYamlConfigRaw = {
    config: TConfig,
    steps: ({ log: TLog } | { shell: TYamlShell } | { predefined: TPredefined })[],
}

export type TYamlConfig = {
    config: TConfig,
    steps: ({ log: TLog } | { shell: ShellProps } | { predefined: TPredefined })[],
}