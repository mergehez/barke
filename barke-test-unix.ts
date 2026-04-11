// noinspection SpellCheckingInspection

// import * as b from '@mergehez/barke';
import * as b from "./src/index.ts";

const env = b.parseEnv();
const allConfigs = {
    base: {
        sourceBasePath: "./",
        targetBasePath: "/www/wwwroot/gotin-test",
        targetOS: 'unix',
        // windowsServerUnzipCommand: ""
    } as const,
    ssh: {
        host: env.HOST_SERVER,
        port: env.SSH_PORT ? parseInt(env.SSH_PORT) : 22,
        username: env.SSH_USERNAME,
        password: env.SSH_PASSWORD,
    },
    newFiles: {
        dirsWithManyFiles: [
            'public/build',
            'vendor/composer',
            'storage/framework/cache',
            'storage/framework/views',
            'storage/framework/sessions',
        ],
        ignorePatterns: [
            '/vendor',
            '/bootstrap/cache',
            '.gitignore',
            'node_modules',
            '/database',
            '/tests',
            '/example',
            '/resources/js',
            '/resources/arg-vue',
            '/resources/css',
            '/resources/sass',
            '/resources/svg',
            '/resources/markdown',
            '/storage/debugbar',
            '/storage/logs/Books',
            '/public/mp3',
            '/public/images',
            '/public/sitemaps',
            '/lang/backup',
            '*.zip',
            'public/hot',
            'public/sitemap.xml',
            'public/sitemap*.xml',
            '.DS_Store',
            'laravel.log',
            'public/sqlite*',
        ]
    },
    laravelDirsToEnsure: [
        'storage/framework/views',
        'storage/framework/cache',
        'storage/framework/sessions',
        'storage/logs',
        'bootstrap/cache',
        'storage',
    ]
};

const skipVue = process.argv.includes('--skip-vue');

async function start() {
    const executer = b.useExecuter(allConfigs.base)
    const server = await executer.sshConnect(allConfigs.ssh)
    const laravel = executer.useLaravelHelpers();

    await server.exec({
        command: 'sudo chown -R www:www ./storage',
        on_error: 'print'
    });
    await server.exec({
        command: 'sudo chown -R www:www ./bootstrap/cache',
        on_error: 'print'
    });
    await laravel.local.clearCache(true);

    if (!skipVue) {
        await executer.exec({
            command: 'PREFIX=g bun run build',
            on_error: 'print'
        })
        await server.deleteFile('public/build/manifest.json', {on_error: 'ignore'});
        await server.deleteDir('public/build/assets', {
            message: 'Deleting old auto-generated vue&js files on server...',
            on_error: 'ignore'
        });
        await server.deleteFile('public/hot', {on_error: 'ignore'});
    }
    const newFiles = await server.findNewFiles({
        ignorePatterns: allConfigs.newFiles.ignorePatterns,
        dirsWithManyFiles: allConfigs.newFiles.dirsWithManyFiles,
        ignoreFn: (path, stat) => {
            return !(path.includes('/') || path == 'composer.json' || path == 'artisan');
        },
    })

    console.log(newFiles.map(t => t.fullPath));

    executer.exitIfDryRun();

    const zip = executer.compressFiles(newFiles);

    await server.uploadFile(zip.path);
    await server.unzip(zip.path);
    await server.deleteFile(zip.path);
    if (newFiles.some(f => f.trimmedPath == 'composer.json')) {
        await laravel.server.composerUpdate(server);
    }
    await laravel.server.optimize(server);
    await laravel.local.clearCache(true);
    await laravel.server.ensureDirsExist(server, {
        dirs: allConfigs.laravelDirsToEnsure,
        owner: 'www',
        group: 'www',
        permissions: '0775',
    });
    await server.exec({
        command: 'sudo chown -R www:www ./storage',
    })
    server.dispose();
    executer.finish();
}

start();