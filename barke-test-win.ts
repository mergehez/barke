// @ts-nocheck
// noinspection SpellCheckingInspection

import { TFindNewFilesConfig, TSshConfig, TUserConfig, parseEnv, useExecuter } from "./src/index.ts";
// const env = process.env
const env = parseEnv();

const config = {
    site: 'my-site',
    root: {
        targetOS: 'windows',
        sourceBasePath: './bin/publish',
        targetBasePath: 'C:/inetpub/wwwroot/my-site',
    } satisfies TUserConfig,
    sshInfo: {
        host: env.FTP_SERVER,
        username: env.SSH_USERNAME,
        password: env.SSH_PASSWORD,
        port: parseInt(env.SSH_PORT!),
    } satisfies TSshConfig,
    findConfig: {
        ignorePatterns: [
            '/order-logs',
            '.DS_Store',
            '*.txt',
            '*.zip',
            '*.sqlite',
            '*.mdb',
            '*.accdb',
            'hot',
        ],
        ignoreFn: (path, stats) => {
            if (!stats.isDirectory() && !path.includes('/')) {
                return true;
            }
            // console.log(path);
            return false;
        },

        dirsWithManyFiles: [
            'cli/src/deploy/services',
            'wwwroot/build',
        ]
    } satisfies TFindNewFilesConfig,
}

const executer = useExecuter(config.root);
executer.deleteLocalDir('./bin/publish', false, 'ignore');
executer.deleteLocalDir('./wwwroot/build', false, 'ignore');
await executer.exec({
    command: 'cd ClientApp && bun run build',
    message: 'blue|\n-> Building vue project...',
    ignore_stdout: true,
})
const sshConn = await executer.sshConnect(config.sshInfo);
await executer.exec({
    command: 'dotnet publish -c DEBUG -r win-x86 -f net9.0 -o "./bin/publish" -p:CompressionEnabled=false',
    message: 'blue|\n-> Building .net project...',
    ignore_stdout: true,
})
const newFiles = await sshConn.findNewFiles(config.findConfig);
executer.exitIfDryRun();
const zip = executer.compressFiles(newFiles);

await sshConn.uploadFile(zip.path);
const iis = executer.useIISHelpers(sshConn);
await iis.stopSite(config.site, config.site);
await sshConn.deleteDir('wwwroot/build/assets', {
    // on_error: 'ignore'
});
await zip.unzipOnServer(sshConn);
await zip.deleteOnServer(sshConn);
await iis.startSite(config.site, config.site);
zip.deleteLocally();

sshConn.dispose();
executer.finish();