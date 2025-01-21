import { TFtpConfig, TSshConfig, TFindNewFilesConfig, useExecuter } from "./src/index.ts";

const env = process.env

const sshInfo: TSshConfig = {
    host: env.UNIX_SERVER_HOST,
    username: env.UNIX_SSH_USERNAME,
    password: env.UNIX_SSH_PASSWORD,
    port: parseInt(env.UNIX_SSH_PORT!),
}

// const ftpInfo: TFtpConfig = {
//     host: env.UNIX_SERVER_HOST,
//     username: env.UNIX_FTP_USERNAME,
//     password: env.UNIX_FTP_PASSWORD,
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
        'src/services',
    ]
}

const executer = useExecuter({
    targetOS: 'unix',
    sourceBasePath: './',
    targetBasePath: '/www/wwwroot/test',
});

const sshConn = await executer.sshConnect(sshInfo);
// const iis = executer.useIISHelpers(sshConn);
const laravel = executer.useLaravelHelpers();

// sshConn.docker.getImages();

await laravel.local.clearCache();
await laravel.local.build('bun');

const newFiles = await sshConn.findNewFiles(findConfig);
const zip = executer.compressFiles(newFiles);
executer.exitIfDryRun();


// await executer.ftpUpload(ftpInfo, zip.path);
await sshConn.uploadFile(zip.path);

await sshConn.deleteFile('public/build/manifest.json', {
    on_error: 'ignore'
});
await sshConn.deleteDir('public/build/assets', {
    on_error: 'ignore'
});
await zip.unzipOnServer(sshConn);
await zip.deleteOnServer(sshConn);
zip.deleteLocally();

if(newFiles.some(t => t.trimmedPath.includes('composer.json'))){
    await laravel.server.composerUpdate(sshConn);
}

await laravel.server.ensureDirsExist(sshConn, {
    dirs: [
        'storage',
        'bootstrap',
        'storage',
    ],
    owner: 'www',
    group: 'www',
    permissions: '0775',
});

await laravel.local.clearCache();

sshConn.dispose();
executer.finish();