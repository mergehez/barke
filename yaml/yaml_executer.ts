import { TPredefined, TPredefinedWithProps } from "./yaml_types.ts";
import { parseBarkeYaml } from "./yaml_parser.ts";
import { useExecuter } from "../src/index.ts";

const sshMethods = [
    'server:delete_zip',
    // 'server:find_new_files',
    'server:unzip',
    'server:upload_files_ssh',
    'server:laravel_composer_update',
    'server:laravel_ensure_dirs_exist',
    'server:laravel_optimize',
    'server:restart_iis_site',
    'server:start_iis_site',
    'server:stop_iis_site',
];

const ftpMethods = [
    'server:upload_files_ftp',
    'local:dispose_ftp',
];

const sshOrFtpMethods = [
    'server:delete_file',
    'server:delete_files',
    'server:delete_dir',
    'local:delete_file',
    'local:delete_files',
    'local:delete_dir',
];

export const createExecuter = async () => {
    const yamlConfig = await parseBarkeYaml();
    const deploy = useExecuter({
        targetOS: yamlConfig.config.target_os,
        sourceBasePath: yamlConfig.config.local_basepath,
        targetBasePath: yamlConfig.config.remote_basepath,
    });

    function yamlConfigRequiresSSH(requiresFtp: boolean) {
        for (const step of yamlConfig.steps) {
            if ('predefined' in step) {
                const method = step.predefined;
                const name = typeof method === 'string' ? method : method.method;
                if (sshMethods.includes(name)) {
                    return 'use the predefined method: ' + name;
                }

                if(!requiresFtp && name == 'server:find_new_files'){
                    return true;
                }
                // if (name.startsWith('server:') && name != 'server:upload_files_ftp') {
                //     return true;
                // }
            } else if ('shell' in step) {
                step.shell.message ||= undefined;
                if (step.shell.ssh) {
                    return 'use SSH shell commands';
                }
            } else if ('log' in step) {
                continue;
            } else {
                deploy.logError(`"${step}" is not a valid step!`);
                process.exit(1);
            }
        }

        return false;
    }

    function yamlRequiresFtp() {
        for (const step of yamlConfig.steps) {
            if ('predefined' in step) {
                const method = step.predefined;
                const name = typeof method === 'string' ? method : method.method;
                if (ftpMethods.includes(name)) {
                    return 'use the predefined method: ' + name;
                }
            }
        }

        return false;
    }

    function yamlRequiresFtpOrSsh() {
        for (const step of yamlConfig.steps) {
            if ('predefined' in step) {
                const method = step.predefined;
                const name = typeof method === 'string' ? method : method.method;
                if (sshOrFtpMethods.includes(name)) {
                    return 'use the predefined method: ' + name;
                }
            }
        }

        return false;
    }

    return {
        start: async () => {
            const requiresFtp = yamlRequiresFtp();
            const requiresSsh = yamlConfigRequiresSSH(!!requiresFtp);
            
            if(requiresSsh){
                if(!yamlConfig.config.ssh){
                    deploy.logError(`You must provide SSH configuration to ${requiresSsh}! Define "config.host" and "config.ssh" in your yaml file.`);
                    process.exit(1);
                }
                if (!yamlConfig.config.ssh.password && !yamlConfig.config.ssh.private_key_path) {
                    deploy.logError('You must provide either a password or a private key path for SSH connection!');
                    process.exit(1);
                }
            }

            if(requiresFtp){
                if(!yamlConfig.config.ftp){
                    deploy.logError(`You must provide FTP configuration to ${requiresFtp}! Define "config.host" and "config.ftp" in your yaml file.`);
                    process.exit(1);
                }
            }

            const requiresFtpOrSsh = yamlRequiresFtpOrSsh();
            if(requiresFtpOrSsh){
                if(!yamlConfig.config.ssh && !yamlConfig.config.ftp){
                    deploy.logError(`You must provide either SSH or FTP configuration to ${requiresFtpOrSsh}! Define "config.host" and "config.ssh" or "config.ftp" in your yaml file.`);
                    process.exit(1);
                }
            }
            
            const sshConn = requiresSsh
                ? await deploy.sshConnect({
                    host: yamlConfig.config.host,
                    ...yamlConfig.config.ssh
                })
                : undefined;
            const ftpConn = requiresFtp
                ? await deploy.ftpConnect({
                    host: yamlConfig.config.host,
                    ...yamlConfig.config.ftp
                })
                : undefined;
            let iis: ReturnType<typeof deploy.useIISHelpers>;
            let laravel: ReturnType<typeof deploy.useLaravelHelpers>;
            let zipUtils: ReturnType<typeof deploy.compressFiles>;
            let newFiles: Awaited<ReturnType<(Awaited<ReturnType<typeof deploy.sshConnect>>)['findNewFiles']>> | undefined = undefined;

            function exitIfNoSshForZip() {
                if (!sshConn) {
                    deploy.logError('ZIP related server methods are currently only supported with SSH!');
                    process.exit(1);
                }
            }

            // const res = await ftpConn.getFiles('/asfafasf');
            // console.log(res);

            // await ftpConn.uploadFile('yaml/index.ts');
            // await ftpConn.uploadFile('yaml/types.ts');
            // process.exit(0);

            async function runPredefined(method: TPredefined) {
                const name = typeof method === 'string' ? method : method.method;

                if (name.includes(':laravel_'))
                    laravel ??= deploy.useLaravelHelpers();

                switch (name) {
                    case 'local:dispose_ssh':
                        return sshConn!.dispose();
                    case 'local:dispose_ftp':
                        return ftpConn!.dispose();
                    case 'local:exit_if_dry_run':
                        return deploy.exitIfDryRun();
                    case 'local:finish':
                        return deploy.finish();
                    case 'server:delete_zip':
                        if(!zipUtils){
                            deploy.logError('You must first call "server:find_new_files" to use this method: '+name);
                            process.exit(1);
                        }
                        exitIfNoSshForZip();
                        return await zipUtils.deleteOnServer(sshConn!);
                    case 'server:find_new_files':
                        const ignoreCfg = {
                            ignorePatterns: yamlConfig.config.ignores,
                            ignoreFn: () => false,
                        };
                        if(sshConn){
                            newFiles = await sshConn.findNewFiles({
                                ...ignoreCfg,
                                dirsWithManyFiles: yamlConfig.config.dist_dirs
                            });
                            zipUtils = deploy.compressFiles(newFiles);
                        }else if(ftpConn){
                            // deploy.logWarning('-> FTP: When not using SSH, all files will be considered new. (except for the ignored ones)');
                            // newFiles = compareServerFilesWithLocal(yamlConfig.config.local_basepath, deploy.flags, ignoreCfg, [], yamlConfig.config.dist_dirs);

                            newFiles = await ftpConn.findNewFiles({
                                ...ignoreCfg,
                                dirsWithManyFiles: yamlConfig.config.dist_dirs
                            });
                        }else{
                            deploy.logError('You must provide SSH or FTP configuration to use this method: '+name);
                            process.exit(1);
                        }
                        return;
                    case 'server:unzip':
                        if(!zipUtils){
                            deploy.logError('You must first call "server:find_new_files" to use this method: '+name);
                            process.exit(1);
                        }
                        exitIfNoSshForZip();
                        return await zipUtils.unzipOnServer(sshConn!);
                    case 'server:upload_files_ssh':
                        if(!zipUtils){
                            deploy.logError('You must first call "server:find_new_files" to use this method: '+name);
                            process.exit(1);
                        }
                        return await sshConn!.uploadFile(zipUtils.path);
                    case 'server:upload_files_ftp':
                        if(newFiles === undefined){
                            deploy.logError('You must first call "server:find_new_files" to use this method: '+name);
                            process.exit(1);
                        }

                        await ftpConn.uploadFiles(newFiles.map(t => t.fullPath));

                        // return await deploy.ftpUpload({
                        //     host: yamlConfig.config.host,
                        //     ...yamlConfig.config.ftp,
                        // }, zipUtils.path);
                    case 'local:sleep':
                        const m = method as TPredefinedWithProps<'local:sleep'>;
                        return await deploy.sleep(m.ms);

                    case 'server:restart_iis_site':
                    case 'server:start_iis_site':
                    case 'server:stop_iis_site':
                        iis ??= deploy.useIISHelpers(sshConn!);
                        const m2 = method as TPredefinedWithProps<'server:restart_iis_site'>;
                        if (name == 'server:restart_iis_site')
                            return await iis.restartSite(m2.pool, m2.site);
                        if (name == 'server:stop_iis_site')
                            return await iis.stopSite(m2.pool, m2.site);
                        return await iis.startSite(m2.pool, m2.site);

                    case 'local:laravel_clear_cache':
                        return laravel.local.clearCache();
                    case 'server:laravel_optimize':
                        const m12 = typeof method === 'string' ? undefined : method as any;
                        return await laravel.server.optimize(sshConn!, m12);
                    case 'server:laravel_composer_update':
                        const m3 = method as TPredefinedWithProps<'server:laravel_composer_update'>;
                        if (m3.force || newFiles.some(t => t.fullPath.endsWith('composer.json')))
                            return await laravel.server.composerUpdate(sshConn!, m3);
                        return;
                    case 'server:laravel_ensure_dirs_exist':
                        const m4 = method as TPredefinedWithProps<'server:laravel_ensure_dirs_exist'>;
                        return await laravel.server.ensureDirsExist(sshConn!, m4);
                    case 'local:laravel_build':
                        const m7 = method as TPredefinedWithProps<'local:laravel_build'>;
                        return laravel.local.build(m7.pm ?? 'bun', m7.out ?? 'public/build');

                    case 'server:delete_file':
                        const m5 = method as TPredefinedWithProps<'server:delete_file'>;
                        if(sshConn){
                            return await sshConn!.deleteFile(m5.path, m5, m5.from_base_path);
                        }else{
                            return await ftpConn.deleteFile(m5.path);
                        }
                    case 'server:delete_files':
                        const m8 = method as TPredefinedWithProps<'server:delete_files'>;
                        if(sshConn)
                            m8.paths.forEach(async p => await sshConn!.deleteFile(p, m8, m8.from_base_path));
                        else
                            m8.paths.forEach(async p => await ftpConn.deleteFile(p));
                        return;
                    case 'server:delete_dir':
                        const m6 = method as TPredefinedWithProps<'server:delete_dir'>;
                        if(sshConn)
                            return await sshConn!.deleteDir(m6.path, m6, m6.from_base_path);
                        else
                            return await ftpConn.deleteDir(m6.path);

                    case 'local:delete_file':
                        const m9 = method as TPredefinedWithProps<'local:delete_file'>;
                        return deploy.deleteLocalFile(m9.path, m9.from_base_path);
                    case 'local:delete_files':
                        const m10 = method as TPredefinedWithProps<'local:delete_files'>;
                        m10.paths.forEach(async p => deploy.deleteLocalFile(p, m10.from_base_path));
                        return;
                    case 'local:delete_dir':
                        const m11 = method as TPredefinedWithProps<'local:delete_dir'>;
                        return deploy.deleteLocalDir(m11.path, m11.from_base_path);

                    default:
                        deploy.logError(`"${name}" is not a valid predefined method!`);
                        process.exit(1);
                }
            }

            for (const step of yamlConfig.steps) {
                if ('predefined' in step) {
                    await runPredefined(step.predefined);
                } else if ('shell' in step) {
                    step.shell.message ||= undefined;
                    if (step.shell.ssh) {
                        await sshConn!.exec(step.shell)
                    } else {
                        await deploy.exec(step.shell);
                    }
                } else if ('log' in step) {
                    deploy.log(typeof step.log === 'string' ? step.log : step.log.message);
                } else {
                    deploy.logError(`"${step}" is not a valid step!`);
                    process.exit(1);
                }
            }
        }
    }
}