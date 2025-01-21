import { TFtpConfig, TSshConfig, TFindNewFilesConfig, useExecuter } from "./src/index.ts";

const env = process.env

const sshInfo: TSshConfig = {
    host: env.WIN_SERVER_HOST,
    username: env.WIN_SSH_USERNAME,
    password: env.WIN_SSH_PASSWORD,
    port: parseInt(env.WIN_SSH_PORT!),
}

// const ftpInfo: TFtpConfig = {
//     host: env.WIN_SERVER_HOST,
//     username: env.WIN_FTP_USERNAME,
//     password: env.WIN_FTP_PASSWORD,
//     base_path: '/www/wwwroot/test',
// }

const findConfig: TFindNewFilesConfig = {
    ignorePatterns: [
        '/toIgnore',
        '*.txt',
    ],

    ignoreFn: (path, stats) => {
        if(!stats.isDirectory() && !path.includes('/')){
            return true;
        }
        console.log(path);
        return false;
    },

    dirsWithManyFiles: [
        'cli/src/deploy/services',
    ]
}

const executer = useExecuter({
    targetOS: 'windows',
    sourceBasePath: './bin/publish',
    targetBasePath: 'C:/inetpub/wwwroot/testo',
});

const sshConn = await executer.sshConnect(sshInfo);
const iis = executer.useIISHelpers(sshConn);
// const laravel = executer.useLaravelHelpers();



// await laravel.local.clearCache();
// await laravel.local.build('bun');
executer.exec({
    command: 'dotnet publish -c ReleaseDev -r win-x86 -f net8.0 -o "./bin/publish"',
    message: 'Building project...',
})
const newFiles = await sshConn.findNewFiles(findConfig);
const zip = executer.compressFiles(newFiles);
executer.exitIfDryRun();

// await executer.ftpUpload(ftpInfo, zip.path);
await sshConn.uploadFile(zip.path);

// await sshConn.deleteFile('public/build/manifest.json', {
//     on_error: 'ignore'
// });
// await sshConn.deleteDir('public/build/assets', {
//     on_error: 'ignore'
// });
iis.stopSite('testo', 'testo');
await zip.unzipOnServer(sshConn);
await zip.deleteOnServer(sshConn);
iis.startSite('testo', 'testo');
zip.deleteLocally();

// if(newFiles.some(t => t.trimmedPath.includes('composer.json'))){
//     await laravel.server.composerUpdate(sshConn);
// }

// await laravel.server.ensureDirsExist(sshConn, {
//     dirs: [
//         'storage',
//         'bootstrap',
//         'storage',
//     ],
//     owner: 'www',
//     group: 'www',
//     permissions: '0775',
// });

// await laravel.local.clearCache();

sshConn.dispose();
executer.finish();